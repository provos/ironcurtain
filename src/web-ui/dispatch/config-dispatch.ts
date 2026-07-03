/**
 * Config-related JSON-RPC method dispatch.
 *
 * Handles `config.*` methods, scoped to the `modelProviders` provider-profile
 * registry only (see docs/designs/openrouter-integration.md §5-G / §12.6):
 *   - `config.getModelProviders` — read; masks every openrouter profile's key.
 *   - `config.setModelProviders` — mutation; gated on `ctx.allowPolicyMutation`,
 *     persists the WHOLE section via `saveUserConfig`, emits `config.changed`.
 *
 * Mirrors the `personas.*` gated-mutation pattern for the gate + change-event
 * (persona-dispatch.ts:219,286). Unlike personas, the mutation persists to
 * `~/.ironcurtain/config.json` via `saveUserConfig`.
 */

import { z } from 'zod';

import { validateParams } from './types.js';
import type { WorkflowDispatchContext } from './workflow-dispatch.js';
import { type GetModelProvidersDto, type ProfileDto, RpcError, MethodNotFoundError } from '../web-ui-types.js';
import {
  loadUserConfig,
  saveUserConfig,
  DOCKER_AGENTS,
  NATIVE_PROFILE_NAME,
  type UserConfig,
  type ResolvedModelProvidersConfig,
  type ResolvedOpenRouterProfile,
} from '../../config/user-config.js';

// ---------------------------------------------------------------------------
// API-key masking
// ---------------------------------------------------------------------------

/**
 * Masks an API key for the wire (`sk-...xyz` / 'none'). Mirrors `maskApiKey` in
 * `config-command.ts:89` exactly. Duplicated (not imported) because that module
 * pulls in `@clack/prompts` at its top level — an interactive-CLI dependency we
 * must not drag into the daemon's WS dispatch path. The mask FORMAT (not the
 * import) is the DTO contract (§12.6).
 */
function maskApiKey(key: string | undefined | null): string {
  if (!key) return 'none';
  if (key.length <= 6) return '***';
  return key.slice(0, 3) + '...' + key.slice(-3);
}

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

const modelMapRuleDtoSchema = z.object({
  match: z.string().min(1),
  model: z.string().min(1),
});

const providerPreferenceDtoSchema = z.object({
  order: z.array(z.string().min(1)).optional(),
  only: z.array(z.string().min(1)).optional(),
  allowFallbacks: z.boolean().optional(),
});

const nativeProfileDtoSchema = z.object({ type: z.literal('native') }).strict();

/**
 * The openrouter profile DTO on the write path. `apiKey` is intentionally
 * permissive (string | null | absent) because the M5 mask-unchanged contract
 * distinguishes absent/null/mask-equal ("keep") from '' ("clear") from any
 * other string ("set") — the empty string is a MEANINGFUL sentinel here, so it
 * must not be rejected by a `.min(1)`.
 */
const openrouterProfileDtoSchema = z
  .object({
    type: z.literal('openrouter'),
    apiKey: z.string().nullable().optional(),
    modelMap: z.array(modelMapRuleDtoSchema).optional(),
    perAgent: z.record(z.string(), z.string().min(1).optional()).optional(),
    providerPreference: providerPreferenceDtoSchema.optional(),
    sessionAffinity: z.boolean().optional(),
  })
  .strict();

const profileDtoSchema = z.discriminatedUnion('type', [nativeProfileDtoSchema, openrouterProfileDtoSchema]);

const setModelProvidersSchema = z.object({
  default: z.string().min(1).optional(),
  profiles: z.record(z.string().min(1), profileDtoSchema),
});

const getModelProvidersSchema = z.object({});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
export async function configDispatch(
  ctx: WorkflowDispatchContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'config.getModelProviders': {
      validateParams(getModelProvidersSchema, params);
      return getModelProviders();
    }

    case 'config.setModelProviders': {
      requirePolicyMutation(ctx);
      const input = validateParams(setModelProvidersSchema, params);
      return setModelProviders(ctx, input);
    }

    default:
      throw new MethodNotFoundError(method);
  }
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

/** Maps a resolved registry to the masked wire DTO. */
function toGetDto(resolved: ResolvedModelProvidersConfig): GetModelProvidersDto {
  const profiles: Record<string, ProfileDto> = {};
  for (const [name, profile] of Object.entries(resolved.profiles)) {
    profiles[name] = profile.type === 'native' ? { type: 'native' } : toOpenrouterDto(profile);
  }
  return { default: resolved.default, profiles };
}

function toOpenrouterDto(profile: ResolvedOpenRouterProfile): ProfileDto {
  const perAgent: Record<string, string | undefined> = {};
  for (const agent of DOCKER_AGENTS) perAgent[agent] = profile.perAgent[agent];
  return {
    type: 'openrouter',
    apiKey: maskApiKey(profile.apiKey),
    modelMap: profile.modelMap.map((r) => ({ match: r.match, model: r.model })),
    perAgent,
    providerPreference: profile.providerPreference
      ? {
          order: profile.providerPreference.order ? [...profile.providerPreference.order] : undefined,
          only: profile.providerPreference.only ? [...profile.providerPreference.only] : undefined,
          allowFallbacks: profile.providerPreference.allowFallbacks,
        }
      : undefined,
    sessionAffinity: profile.sessionAffinity,
  };
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
  // Snapshot the currently-resolved profiles so M5 can compare against the
  // stored key and preserve it when the wire value equals its mask.
  const currentProfiles = loadUserConfig({ readOnly: true }).modelProviders.profiles;

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
    profiles[name] = buildOpenrouterInput(name, dto, currentProfiles[name]);
  }

  // F10: re-point a `default` that names a profile DROPPED in this write (one
  // that existed in the stored config but is absent from the new `profiles`).
  // A `default` naming a profile that never existed at all is NOT re-pointed —
  // it falls through to the Zod `.refine` in saveUserConfig and is rejected
  // (validation-passthrough: the request itself set a bad default).
  const priorNames = Object.keys(currentProfiles);
  const resolvedDefault = repointDefault(input.default, profiles, priorNames);

  const modelProviders: NonNullable<UserConfig['modelProviders']> = { profiles };
  if (resolvedDefault !== undefined) modelProviders.default = resolvedDefault;

  // saveUserConfig re-validates via the Zod schema (including the reserved-name
  // and default-must-exist `.refine`s), so a request that names a genuinely
  // missing profile in `default` (not the F10 delete case) throws here.
  try {
    saveUserConfig({ modelProviders });
  } catch (err) {
    throw new RpcError('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }

  ctx.eventBus.emit('config.changed', {});
  return getModelProviders();
}

type OpenrouterInput = NonNullable<NonNullable<UserConfig['modelProviders']>['profiles']>[string];

/**
 * Builds one openrouter profile's persisted input shape from its DTO, resolving
 * the M5 apiKey contract against the currently-stored profile.
 */
function buildOpenrouterInput(
  name: string,
  dto: Extract<ProfileDto, { type: 'openrouter' }>,
  current: ResolvedModelProvidersConfig['profiles'][string] | undefined,
): OpenrouterInput {
  const currentKey = current?.type === 'openrouter' ? current.apiKey : '';
  const resolvedKey = resolveApiKey(dto.apiKey, currentKey);

  const out: Extract<OpenrouterInput, { type: 'openrouter' }> = { type: 'openrouter' };
  // The persisted schema requires apiKey.min(1); an empty resolved key means
  // "no key" and is written by OMITTING the field entirely.
  if (resolvedKey) out.apiKey = resolvedKey;
  if (dto.modelMap !== undefined) out.modelMap = dto.modelMap.map((r) => ({ match: r.match, model: r.model }));
  const perAgent = buildPerAgent(dto.perAgent);
  if (perAgent) out.perAgent = perAgent;
  if (dto.providerPreference) {
    const pp = dto.providerPreference;
    out.providerPreference = {
      order: pp.order ? [...pp.order] : undefined,
      only: pp.only ? [...pp.only] : undefined,
      allowFallbacks: pp.allowFallbacks,
    };
  }
  if (dto.sessionAffinity !== undefined) out.sessionAffinity = dto.sessionAffinity;
  return out;
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
