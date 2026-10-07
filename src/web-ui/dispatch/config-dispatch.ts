/**
 * Config-related JSON-RPC method dispatch.
 *
 * Handles the user-config sections exposed in the web Settings view:
 *   - `config.getModelProviders` — read; masks every openrouter profile's key.
 *   - `config.setModelProviders` — mutation; gated on `ctx.allowPolicyMutation`,
 *     persists the WHOLE section via `saveUserConfig`, emits `config.changed`.
 *   - `config.getDockerWorkload` — read; returns enablement plus the three-state network selector.
 *   - `config.setDockerWorkload` — gated mutation; persists only those controls.
 *   - `config.getStatistics` / `config.setStatistics` — resolved statistics
 *     settings, with the same mutation gate and change event.
 *
 * Mirrors the `personas.*` gated-mutation pattern for the gate + change-event
 * (persona-dispatch.ts:219,286). Unlike personas, the mutation persists to
 * `~/.ironcurtain/config.json` via `saveUserConfig`.
 */

import { z } from 'zod';

import { validateParams } from './types.js';
import type { WorkflowDispatchContext } from './workflow-dispatch.js';
import {
  type GetModelProvidersDto,
  type DockerWorkloadSettingsDto,
  type OpenrouterModelsDto,
  type ProfileDto,
  type StatisticsConfigDto,
  type ResourceBudgetConfigDto,
  RpcError,
  MethodNotFoundError,
} from '../web-ui-types.js';
import {
  loadUserConfig,
  resourceBudgetFieldsSchema,
  loadRequestedDockerWorkloadConfig,
  saveUserConfig,
  maskApiKey,
  DOCKER_AGENTS,
  NATIVE_PROFILE_NAME,
  type UserConfig,
  type ResolvedModelProvidersConfig,
} from '../../config/user-config.js';
import { listProviderModels } from '../../config/provider-catalog.js';
import { getProviderEditorDescriptors, providerProfileSummary } from '../../config/provider-definitions.js';
import { resolvedGatewayToInput } from '../../config/provider-editor.js';
import { providerProfileSchema } from '../../config/user-config.js';
import { DOCKER_WORKLOAD_NETWORK_ACCESS } from '../../docker-workload/config.js';

// The mask FORMAT that `maskApiKey` produces is the DTO contract (§12.6): the
// `resolveApiKey` round-trip below compares an incoming wire value against
// `maskApiKey(currentKey)`, and the frontend renders the same shape. It is
// shared from the `user-config.ts` leaf so the CLI editor and this daemon
// dispatch cannot drift — without dragging the editor's `@clack/prompts` import
// onto the WS path.

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

/** Reuse authoritative built-in schemas; masked keys and the legacy per-agent write projection differ from persistence. */
const profileDtoSchema = z.discriminatedUnion('type', [
  providerProfileSchema.options[0].strict(),
  ...providerProfileSchema.options.slice(1).map((schema) =>
    schema
      .extend({
        apiKey: z.string().nullable().optional(),
        perAgent: z.record(z.string(), z.string().min(1).optional()).optional(),
      })
      .strict(),
  ),
]);

const setModelProvidersSchema = z.object({
  default: z.string().min(1).optional(),
  renameFrom: z.record(z.string().min(1), z.string().min(1)).optional(),
  profiles: z.record(z.string().min(1), profileDtoSchema),
});

const getModelProvidersSchema = z.object({});

const listProviderModelsSchema = z
  .object({ service: z.string().min(1), forceRefresh: z.boolean().optional() })
  .strict();
const listOpenrouterModelsSchema = z.object({ forceRefresh: z.boolean().optional() });
const statisticsConfigSchema = z
  .object({ enabled: z.boolean(), retentionDays: z.number().int().positive().nullable() })
  .strict();

const getDockerWorkloadSchema = z.object({});

const setDockerWorkloadSchema = z
  .object({
    enabled: z.boolean(),
    networkAccess: z.enum(DOCKER_WORKLOAD_NETWORK_ACCESS),
  })
  .strict();

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function configDispatch(
  ctx: WorkflowDispatchContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'config.getResourceBudget': {
      validateParams(z.object({}).strict(), params);
      return loadUserConfig({ readOnly: true }).resourceBudget;
    }

    case 'config.setResourceBudget': {
      requirePolicyMutation(ctx);
      const input: ResourceBudgetConfigDto = validateParams(resourceBudgetFieldsSchema.required().strict(), params);
      try {
        // Refuse to overwrite an unreadable config; saveUserConfig otherwise starts fresh on corrupt JSON.
        loadUserConfig({ readOnly: true });
        saveUserConfig({ resourceBudget: input });
      } catch (err) {
        throw new RpcError('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
      ctx.eventBus.emit('config.changed', {});
      return loadUserConfig({ readOnly: true }).resourceBudget;
    }

    case 'config.getModelProviders': {
      validateParams(getModelProvidersSchema, params);
      return getModelProviders();
    }

    case 'config.setModelProviders': {
      requirePolicyMutation(ctx);
      const input = validateParams(setModelProvidersSchema, params);
      return setModelProviders(ctx, input);
    }

    case 'config.getDockerWorkload': {
      validateParams(getDockerWorkloadSchema, params);
      return getDockerWorkload();
    }

    case 'config.setDockerWorkload': {
      requirePolicyMutation(ctx);
      const input = validateParams(setDockerWorkloadSchema, params);
      return setDockerWorkload(ctx, input);
    }

    case 'config.getStatistics': {
      validateParams(z.object({}).strict(), params);
      return getStatistics();
    }

    case 'config.setStatistics': {
      requirePolicyMutation(ctx);
      const input = validateParams(statisticsConfigSchema, params);
      return setStatistics(ctx, input);
    }

    // Ungated read of the PUBLIC OpenRouter catalog (mirrors getModelProviders).
    case 'config.listOpenrouterModels': {
      const input = validateParams(listOpenrouterModelsSchema, params);
      const result = await listProviderModels('openrouter', { forceRefresh: input.forceRefresh });
      return { models: result.models, source: result.source } satisfies OpenrouterModelsDto;
    }

    case 'config.listProviderModels': {
      const input = validateParams(listProviderModelsSchema, params);
      if (!getProviderEditorDescriptors().some((provider) => provider.id === input.service)) {
        throw new RpcError('INVALID_PARAMS', `Unknown built-in model provider "${input.service}".`);
      }
      const result = await listProviderModels(input.service, { forceRefresh: input.forceRefresh });
      return { models: result.models, source: result.source } satisfies OpenrouterModelsDto;
    }

    default:
      throw new MethodNotFoundError(method);
  }
}

function getStatistics(): StatisticsConfigDto {
  const statistics = loadUserConfig({ readOnly: true }).statistics;
  return {
    enabled: statistics.enabled,
    retentionDays: statistics.retentionDays,
  };
}

function setStatistics(ctx: WorkflowDispatchContext, input: StatisticsConfigDto): StatisticsConfigDto {
  try {
    saveUserConfig({ statistics: { enabled: input.enabled, retentionDays: input.retentionDays } });
  } catch (err) {
    throw new RpcError('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }
  ctx.eventBus.emit('config.changed', {});
  return getStatistics();
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Returns the resolved `modelProviders` registry with every openrouter
 * profile's `apiKey` masked. Read-only load so a bare read never mutates the
 * config file. The `native` profile is included key-less.
 */
function getModelProviders(): GetModelProvidersDto {
  const resolved = loadUserConfig({ readOnly: true }).modelProviders;
  return toGetDto(resolved);
}

/**
 * Returns only the product-level choices. The validated requested value is
 * consulted while disabled so its preference survives a disable/re-enable
 * cycle; a no-choice disabled block displays recommended packages without a
 * write or authority grant.
 */
function getDockerWorkload(): DockerWorkloadSettingsDto {
  const requested = loadRequestedDockerWorkloadConfig();
  return {
    enabled: requested?.enabled === true,
    networkAccess: requested?.networkAccess ?? 'packages',
  };
}

/** Maps a resolved registry to the masked wire DTO. */
function toGetDto(resolved: ResolvedModelProvidersConfig): GetModelProvidersDto {
  const profiles: Record<string, ProfileDto> = {};
  const summaries: Record<string, string> = {};
  for (const [name, profile] of Object.entries(resolved.profiles)) {
    if (profile.type === 'native') {
      profiles[name] = { type: 'native' };
      summaries[name] = 'Native providers (Anthropic / OpenAI / ChatGPT)';
    } else {
      profiles[name] = {
        ...resolvedGatewayToInput(profile),
        perAgent: { ...profile.perAgent },
        apiKey: maskApiKey(profile.apiKey),
      };
      summaries[name] = `${providerProfileSummary(profile)} · key: ${maskApiKey(profile.apiKey)}`;
    }
  }
  return { default: resolved.default, profiles, providers: getProviderEditorDescriptors(), summaries };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

type SetInput = z.infer<typeof setModelProvidersSchema>;

/**
 * Persists the whole `modelProviders` section. Applies, in order:
 *   - F7: silently drop a verbatim `profiles.native = { type: 'native' }`;
 *     reject any other value under the `native` key.
 *   - M5: per-profile apiKey — absent/null/mask-equal → keep stored key,
 *     '' → clear, other → set (compared against the currently-resolved key).
 *   - F10: if `default` names a profile absent from the write, re-point it to
 *     'native' in the same write (never persist a dangling `default`).
 *
 * Writes the whole section via `saveUserConfig` (the shallow `deepMergeConfig`
 * replaces `profiles` wholesale, so a partial write drops unmentioned profiles).
 * Emits `config.changed`, then returns the fresh masked get DTO.
 */
function setModelProviders(ctx: WorkflowDispatchContext, input: SetInput): GetModelProvidersDto {
  // Snapshot the currently-resolved registry so M5 can compare against the
  // stored key (preserve when the wire value equals its mask) and F10 can see
  // the stored default when the write omits one.
  const currentUserConfig = loadUserConfig({ readOnly: true });
  const current = currentUserConfig.modelProviders;
  const currentProfiles: Partial<typeof current.profiles> = current.profiles;
  const requestedProfiles: Partial<SetInput['profiles']> = input.profiles;

  const renames = input.renameFrom ?? {};
  const originals = new Set<string>();
  for (const [name, original] of Object.entries(renames)) {
    const prior = currentProfiles[original];
    const renamed = requestedProfiles[name];
    if (
      original === NATIVE_PROFILE_NAME ||
      name === NATIVE_PROFILE_NAME ||
      originals.has(original) ||
      !prior ||
      !renamed ||
      requestedProfiles[original] ||
      currentProfiles[name] ||
      renamed.type !== prior.type
    ) {
      throw new RpcError(
        'INVALID_PARAMS',
        'Profile rename must preserve its service and move one existing profile to a new name.',
      );
    }
    originals.add(original);
  }
  const hostModelProfiles = { ...currentUserConfig.hostModelProfiles };
  for (const [role, name] of Object.entries(hostModelProfiles)) {
    const renamed = Object.keys(renames).find((key) => renames[key] === name);
    if (renamed) hostModelProfiles[role as keyof typeof hostModelProfiles] = renamed;
    else if (name !== NATIVE_PROFILE_NAME && !requestedProfiles[name]) {
      throw new RpcError(
        'INVALID_PARAMS',
        `Profile "${name}" is used by host role "${role}". Select another host profile in ironcurtain config before deleting it.`,
      );
    }
  }
  const profiles: Record<string, NonNullable<NonNullable<UserConfig['modelProviders']>['profiles']>[string]> = {};
  for (const [name, dto] of Object.entries(input.profiles)) {
    if (name === NATIVE_PROFILE_NAME) {
      // F7: accept-and-drop a verbatim native echo; reject anything else.
      if (dto.type === 'native') continue;
      throw new RpcError(
        'INVALID_PARAMS',
        `"${NATIVE_PROFILE_NAME}" is a reserved profile name and cannot be redefined.`,
      );
    }
    if (dto.type === 'native') {
      // A user-named native profile is inert but harmless; persist as-is.
      profiles[name] = { type: 'native' };
      continue;
    }
    const prior = currentProfiles[renames[name] ?? name];
    if (prior && prior.type !== 'native' && prior.type !== dto.type && dto.apiKey === maskApiKey(prior.apiKey)) {
      throw new RpcError(
        'INVALID_PARAMS',
        'Changing provider service requires a new API key; a displayed key mask cannot be reused.',
      );
    }
    const apiKey = resolveApiKey(dto.apiKey, prior?.type === dto.type ? prior.apiKey : '');
    profiles[name] = providerProfileSchema.parse({
      ...dto,
      apiKey: apiKey || undefined,
      modelMap: dto.modelMap?.map((rule) => ({ ...rule })),
      perAgent: buildPerAgent(dto.perAgent),
    });
  }

  // F10: re-point a `default` that names a profile DROPPED in this write (one
  // that existed in the stored config but is absent from the new `profiles`).
  // A `default` naming a profile that never existed at all is NOT re-pointed —
  // it falls through to the Zod `.refine` in saveUserConfig and is rejected
  // (validation-passthrough: the request itself set a bad default).
  const priorNames = Object.keys(currentProfiles);
  const requestedDefault = input.default ?? current.default;
  const renamedDefault = Object.keys(renames).find((key) => renames[key] === requestedDefault);
  let resolvedDefault = renamedDefault ?? repointDefault(input.default, profiles, priorNames);
  if (input.default === undefined) {
    // The client omitted `default`; the shallow config merge would preserve the
    // stored default. If THIS write deletes the profile that default names, that
    // preserved default would dangle and saveUserConfig's schema `.refine` would
    // reject the whole write with a confusing INVALID_PARAMS. Auto-repoint to
    // native for that case — the same F10 outcome as sending it explicitly.
    if (
      renamedDefault === undefined &&
      current.default !== NATIVE_PROFILE_NAME &&
      !(current.default in profiles) &&
      priorNames.includes(current.default)
    ) {
      resolvedDefault = NATIVE_PROFILE_NAME;
    }
  }

  const modelProviders: NonNullable<UserConfig['modelProviders']> = { profiles };
  if (resolvedDefault !== undefined) modelProviders.default = resolvedDefault;

  // saveUserConfig re-validates via the Zod schema (including the reserved-name
  // and default-must-exist `.refine`s), so a request that names a genuinely
  // missing profile in `default` (not the F10 delete case) throws here.
  try {
    saveUserConfig({ modelProviders, ...(currentUserConfig.hostModelProfiles ? { hostModelProfiles } : {}) }, renames);
  } catch (err) {
    throw new RpcError('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }

  ctx.eventBus.emit('config.changed', {});
  return getModelProviders();
}

/**
 * Persists the two fields owned by the web UI. A normal load first performs
 * validated legacy migration so the subsequent canonical write cannot merge
 * old imageIngress and new networkAccess fields.
 */
function setDockerWorkload(ctx: WorkflowDispatchContext, input: DockerWorkloadSettingsDto): DockerWorkloadSettingsDto {
  try {
    loadUserConfig();
    saveUserConfig({
      dockerWorkload: {
        enabled: input.enabled,
        networkAccess: input.networkAccess,
      },
    });
  } catch (err) {
    throw new RpcError('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }

  ctx.eventBus.emit('config.changed', {});
  return getDockerWorkload();
}

/**
 * M5 per-profile apiKey resolution:
 *   - absent / null / equal-to-the-current-mask → keep the stored key
 *   - '' (empty) → clear
 *   - any other string → set
 */
function resolveApiKey(wire: string | null | undefined, currentKey: string): string {
  if (wire === undefined || wire === null) return currentKey;
  if (wire === maskApiKey(currentKey)) return currentKey;
  if (wire === '') return '';
  return wire;
}

/** Compacts a perAgent DTO to the persisted shape, dropping undefined/blank slugs. */
function buildPerAgent(
  input: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> | undefined {
  if (!input) return undefined;
  const out: Record<string, string> = {};
  for (const agent of DOCKER_AGENTS) {
    const slug = input[agent];
    if (slug) out[agent] = slug;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * F10 — resolves the `default` to persist.
 *   - unset → `undefined` (leaves it unset; resolves to 'native' at load).
 *   - 'native' or a name present in the new `profiles` → kept as-is.
 *   - a name absent from `profiles` but present in `priorNames` (a profile
 *     DELETED by this write) → re-pointed to 'native' (never persist a dangling
 *     default, which would make the next `loadUserConfig` a HARD error).
 *   - a name absent from BOTH `profiles` and `priorNames` (a bad/typo default
 *     the request itself introduced) → returned unchanged, so the Zod `.refine`
 *     in saveUserConfig rejects it (validation-passthrough, §12.6).
 */
function repointDefault(
  requested: string | undefined,
  profiles: Record<string, unknown>,
  priorNames: readonly string[],
): string | undefined {
  if (requested === undefined) return undefined;
  if (requested === NATIVE_PROFILE_NAME) return NATIVE_PROFILE_NAME;
  if (requested in profiles) return requested;
  // Present before this write => it was just deleted => repoint. Otherwise it
  // was never a real profile => leave it dangling so validation rejects it.
  return priorNames.includes(requested) ? NATIVE_PROFILE_NAME : requested;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Kill-switch gate for the mutation. Throws POLICY_MUTATION_FORBIDDEN when the
 * daemon was not launched with `--allow-policy-mutation`. Fires BEFORE any disk
 * read so a read-only client never learns config/credential state (mirrors
 * persona-dispatch.ts:252).
 */
function requirePolicyMutation(ctx: WorkflowDispatchContext): void {
  if (ctx.allowPolicyMutation !== true) {
    throw new RpcError('POLICY_MUTATION_FORBIDDEN', 'Policy mutation is not enabled on this daemon.');
  }
}
