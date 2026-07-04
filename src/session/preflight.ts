/**
 * Pre-flight checks and explicit session mode selection.
 *
 * When `--agent` is explicit, validates prerequisites and fails fast.
 * When no `--agent` is given, dispatches on the user's `preferredMode`
 * (`'docker'` or `'builtin'`) — there is no silent fallback. If the
 * preferred mode's prerequisites are unmet, a `PreflightError` is raised
 * with remediation hints and the session refuses to start.
 */

import type { DockerAuthKind, IronCurtainConfig } from '../config/types.js';
import type { AgentId } from '../docker/agent-adapter.js';
import type { SessionMode } from './types.js';
import {
  detectAuthMethod,
  preflightCredentialSources,
  readOnlyCredentialSources,
  type CredentialSources,
} from '../docker/oauth-credentials.js';
import {
  resolveApiKeyForProvider,
  parseModelId,
  PROVIDER_ENV_VARS,
  type ProviderId,
} from '../config/model-provider.js';
import { resolveActiveProfile } from '../config/user-config.js';
// The Docker availability probe lives in `docker/docker-probe.js` (a
// dependency-free leaf) so runtime modules can use it without importing this
// file. Import callers reference `docker-probe.js` directly.
import { checkDockerAvailable, type DockerAvailability } from '../docker/docker-probe.js';

/**
 * Thrown when explicit `--agent` prerequisites are not met, or when the
 * user's `preferredMode` cannot be honored (Docker unavailable while
 * preferring docker, missing API key while preferring builtin, etc.).
 */
export class PreflightError extends Error {
  constructor(message: string) {
    super(`${message}\n\nRun \`ironcurtain doctor\` for a full diagnostic.`);
    this.name = 'PreflightError';
  }
}

export interface PreflightResult {
  readonly mode: SessionMode;
  /** Human-readable explanation of why this mode was selected. */
  readonly reason: string;
}

export interface PreflightOptions {
  config: IronCurtainConfig;
  /** The --agent flag value. undefined = use preferredMode from config. */
  requestedAgent?: AgentId;
  /**
   * The per-session `--provider-profile` selection (fresh Docker sessions only).
   * When it names an OpenRouter profile, preflight authenticates against that
   * profile's OpenRouter key instead of the agent-native credential, so the
   * credential banner/block matches the routing the session will actually use.
   * Undefined resolves the config default — the unchanged behavior for mux,
   * daemon, cron, and resumes (which restore the original profile later). An
   * unknown name propagates `resolveActiveProfile`'s authoritative
   * available-profiles error early (before credential detection), so a
   * `--provider-profile` typo surfaces as "unknown profile" rather than being
   * masked by a generic "no credentials" error when the default lacks creds.
   */
  providerProfileName?: string;
  /** Dependency injection for tests. Defaults to real Docker check. */
  isDockerAvailable?: () => Promise<DockerAvailability>;
  /** Dependency injection for tests. Defaults to real credential detection. */
  credentialSources?: CredentialSources;
}

/** `anthropicOAuthOnly` is only meaningful for goose: it lets the goose
 *  error message tell a tester that present OAuth credentials are unusable. */
interface CredentialState {
  credKind: DockerAuthKind | null;
  anthropicOAuthOnly: boolean;
}

/** Human-readable label for a resolved auth kind, used in the preflight banner. */
function authKindLabel(kind: DockerAuthKind): string {
  return kind === 'oauth' ? 'OAuth' : 'API key';
}

async function detectCredentialState(
  agentId: AgentId,
  config: IronCurtainConfig,
  sources: CredentialSources,
  providerProfileName: string | undefined,
): Promise<CredentialState> {
  // OpenRouter integration (§9.7): when the resolved active profile is
  // openrouter-type, the container authenticates with the profile's OpenRouter
  // key — not the agent-native credential. The interactive banner would
  // otherwise report "no credentials" for an OpenRouter-only user. The
  // per-session `--provider-profile` override is honored here (native profiles
  // fall through to the agent-native detection unchanged). An unknown name
  // makes `resolveActiveProfile` throw its authoritative available-profiles
  // listing — we let that propagate so the typo surfaces here, before
  // credential detection, identically whether or not the default has creds
  // (rather than masking it behind a generic "no credentials" error).
  const activeProfile = resolveActiveProfile(config.userConfig.modelProviders, providerProfileName);
  if (activeProfile.type === 'openrouter') {
    return { credKind: activeProfile.apiKey ? 'apikey' : null, anthropicOAuthOnly: false };
  }

  if (agentId === 'goose') {
    const provider = config.userConfig.gooseProvider;
    const key = resolveApiKeyForProvider(provider, config.userConfig);
    if (key) return { credKind: 'apikey', anthropicOAuthOnly: false };

    const auth = await detectAuthMethod(config, sources);
    return {
      credKind: null,
      anthropicOAuthOnly:
        auth.kind === 'oauth' && resolveApiKeyForProvider('anthropic', config.userConfig).length === 0,
    };
  }

  if (agentId === 'codex') {
    const { loadCodexOAuthCredentials } = await import('../docker/oauth-credentials.js');
    if (loadCodexOAuthCredentials()) return { credKind: 'oauth', anthropicOAuthOnly: false };
    return { credKind: null, anthropicOAuthOnly: false };
  }

  const auth = await detectAuthMethod(config, sources);
  if (auth.kind === 'none') return { credKind: null, anthropicOAuthOnly: false };
  return { credKind: auth.kind, anthropicOAuthOnly: false };
}

/**
 * Resolves Docker availability and credential presence concurrently, then —
 * only on the success path — triggers a proactive OAuth-refresh round-trip.
 *
 * The phase split is what gives us both speed AND clean failure semantics:
 *   - Phase 1 (parallel): Docker probe + read-only credential check.
 *     No side effects. If either fails we throw without ever touching the
 *     refresh path, so a Docker-unavailable run can't burn an OAuth refresh
 *     token.
 *   - Phase 2 (post-confirm): if both passed and the credential is OAuth,
 *     re-run detection with `preflightCredentialSources` so a near-expired
 *     token is rotated before the first MCP call.
 *
 * Tests that inject `credentialSources` get phase-1-only behavior with
 * their fixture — the injection encodes the test's chosen semantics, so
 * rerunning with refresh-capable sources would defeat the override.
 */
async function probeDockerAndCredentials(
  agent: AgentId,
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources: CredentialSources | undefined,
  providerProfileName: string | undefined,
): Promise<{ dockerStatus: DockerAvailability; credState: CredentialState }> {
  const phase1Sources = credentialSources ?? readOnlyCredentialSources;
  const [dockerStatus, credState] = await Promise.all([
    isDockerAvailable(),
    detectCredentialState(agent, config, phase1Sources, providerProfileName),
  ]);

  if (!credentialSources && dockerStatus.available && credState.credKind === 'oauth') {
    await detectAuthMethod(config, preflightCredentialSources);
  }

  return { dockerStatus, credState };
}

/**
 * Renders the "switch to <other mode>" remediation footer shared by every
 * preflight error message. Centralized so the wording can't drift between
 * the docker-unavailable, builtin-needs-key, and credential-missing paths.
 */
function formatModeRemediation(targetMode: 'docker' | 'builtin'): string[] {
  if (targetMode === 'builtin') {
    return [
      'To run this session in builtin mode, pass:',
      '  --agent builtin',
      '',
      'To make builtin the default permanently, run:',
      '  ironcurtain config',
      'and set Session Mode > Preferred mode to "builtin".',
    ];
  }
  return [
    'To run this session in Docker mode, pass:',
    '  --agent claude-code',
    '',
    'To make Docker the default permanently, run:',
    '  ironcurtain config',
    'and set Session Mode > Preferred mode to "docker".',
  ];
}

function credentialErrorMessageForExplicit(agentId: AgentId, config: IronCurtainConfig, oauthOnly: boolean): string {
  if (agentId === 'goose') {
    const provider = config.userConfig.gooseProvider;
    const base =
      `--agent goose requires an API key for provider "${provider}". ` +
      'Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY, ' +
      'or configure via `ironcurtain config`.';
    const parts: string[] = [base];
    if (provider === 'anthropic' && oauthOnly) {
      parts.push('OAuth credentials are not usable with goose; provider "anthropic" requires an API key.');
    }
    if (provider === 'anthropic' && process.env.ANTHROPIC_AUTH_TOKEN) {
      parts.push(
        'Note: IronCurtain does not honor `ANTHROPIC_AUTH_TOKEN` (Bearer/gateway auth). ' +
          'To route Anthropic traffic through a gateway, run LiteLLM as a sidecar and ' +
          'point `ANTHROPIC_BASE_URL` at it with `ANTHROPIC_API_KEY` set to the LiteLLM key.',
      );
    }
    return parts.join('\n\n');
  }
  if (agentId === 'codex') {
    return (
      '--agent codex requires Codex ChatGPT authentication. Run `codex login` on the host, ' +
      'or provide a Codex access token with `codex login --with-access-token`. OPENAI_API_KEY is not required.'
    );
  }
  return `--agent ${agentId} requires authentication. Log in with \`claude login\` (OAuth) or set ANTHROPIC_API_KEY.`;
}

function credentialErrorMessageForPreferredMode(
  agentId: AgentId,
  config: IronCurtainConfig,
  oauthOnly: boolean,
): string {
  const lines: string[] = [
    'Cannot start IronCurtain.',
    `preferredMode is "docker" but no credentials are configured for "${agentId}".`,
    '',
  ];
  if (agentId === 'goose') {
    const provider = config.userConfig.gooseProvider;
    lines.push(
      `Goose requires an API key for provider "${provider}". ` +
        'Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY, ' +
        'or configure via `ironcurtain config`.',
    );
    if (provider === 'anthropic' && oauthOnly) {
      lines.push('');
      lines.push('OAuth credentials are not usable with goose; provider "anthropic" requires an API key.');
    }
    if (provider === 'anthropic' && process.env.ANTHROPIC_AUTH_TOKEN) {
      lines.push('');
      lines.push(
        'Note: IronCurtain does not honor `ANTHROPIC_AUTH_TOKEN` (Bearer/gateway auth). ' +
          'To route Anthropic traffic through a gateway, run LiteLLM as a sidecar and ' +
          'point `ANTHROPIC_BASE_URL` at it with `ANTHROPIC_API_KEY` set to the LiteLLM key.',
      );
    }
  } else {
    lines.push(
      agentId === 'codex'
        ? 'Codex ChatGPT authentication is required. Run `codex login` on the host; OPENAI_API_KEY is not required.'
        : `Authentication is required for "${agentId}". Log in with \`claude login\` (OAuth) or set ANTHROPIC_API_KEY.`,
    );
  }
  lines.push('');
  lines.push(...formatModeRemediation('builtin'));
  return lines.join('\n');
}

function dockerUnavailableMessage(detailedMessage: string): string {
  return [
    'Cannot start IronCurtain.',
    'preferredMode is "docker" but Docker is not available:',
    '',
    detailedMessage,
    '',
    ...formatModeRemediation('builtin'),
  ].join('\n');
}

function builtinNeedsApiKeyMessage(provider: ProviderId, qualifiedModelId: string): string {
  const envVar = PROVIDER_ENV_VARS[provider];
  const lines = [
    'Cannot start IronCurtain.',
    `preferredMode is "builtin" but no ${envVar} is configured.`,
    `Builtin mode talks to the "${provider}" provider directly using an API key` +
      ` (selected by your configured model "${qualifiedModelId}").`,
  ];
  // Anthropic users commonly have Claude OAuth credentials from `claude login`;
  // call out that those do not work in builtin mode to avoid confusion.
  if (provider === 'anthropic') {
    lines.push('Claude OAuth credentials are not usable in builtin mode — an API key is required.');
  }
  lines.push(
    '',
    ...formatModeRemediation('docker'),
    '',
    `Set ${envVar} in your environment, or run \`ironcurtain config\`.`,
  );
  return lines.join('\n');
}

/**
 * Renders the user-facing `Mode: ...` banner shown at session startup.
 * Single source of truth so `ironcurtain start`, the daemon, and cron
 * jobs all print identically. Docker mode includes the agent + auth
 * kind via `reason`; builtin has no parenthetical.
 */
export function formatModeLine(preflight: PreflightResult): string {
  if (preflight.mode.kind === 'builtin') return 'Mode: builtin';
  return `Mode: docker / ${preflight.reason}`;
}

/** Per-call-site message strategy for `resolveDockerAgent`. */
interface DockerAgentMessages {
  dockerUnavailable: (detailedMessage: string) => string;
  credentialsMissing: (anthropicOAuthOnly: boolean) => string;
  successReason: (authKind: DockerAuthKind) => string;
}

async function resolveDockerAgent(
  agent: AgentId,
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources: CredentialSources | undefined,
  providerProfileName: string | undefined,
  messages: DockerAgentMessages,
): Promise<PreflightResult> {
  const { dockerStatus, credState } = await probeDockerAndCredentials(
    agent,
    config,
    isDockerAvailable,
    credentialSources,
    providerProfileName,
  );

  if (!dockerStatus.available) {
    throw new PreflightError(messages.dockerUnavailable(dockerStatus.detailedMessage));
  }

  if (credState.credKind === null) {
    throw new PreflightError(messages.credentialsMissing(credState.anthropicOAuthOnly));
  }

  return {
    mode: { kind: 'docker', agent, authKind: credState.credKind },
    reason: messages.successReason(credState.credKind),
  };
}

/**
 * Resolves the session mode based on the explicit `--agent` flag or the
 * user's `preferredMode`.
 *
 * - Explicit agent: validates prerequisites; throws PreflightError on failure.
 * - Default path: dispatches on `preferredMode`. There is no silent
 *   fallback — Docker unavailability or missing credentials throw.
 */
export async function resolveSessionMode(options: PreflightOptions): Promise<PreflightResult> {
  const { config, requestedAgent, credentialSources } = options;
  const isDockerAvailable = options.isDockerAvailable ?? (await resolveDefaultAvailabilityProbe(config));

  if (requestedAgent !== undefined) {
    return resolveExplicit(requestedAgent, config, isDockerAvailable, credentialSources, options.providerProfileName);
  }

  return resolveDefaultMode(config, isDockerAvailable, credentialSources, options.providerProfileName);
}

/**
 * Picks the container-runtime availability probe matching the selected
 * backend: apple-container sessions must probe the Apple `container`
 * services, not Docker (the machine may not have Docker at all).
 * The runtime backends are imported lazily so preflight does not eagerly
 * pull in docker-manager / apple-container-manager on every load.
 */
async function resolveDefaultAvailabilityProbe(config: IronCurtainConfig): Promise<() => Promise<DockerAvailability>> {
  const { resolveRuntimeKind } = await import('../docker/container-runtime.js');
  if ((await resolveRuntimeKind(config.userConfig.containerRuntime)) === 'apple-container') {
    const { checkAppleContainerAvailable } = await import('../docker/apple-container-manager.js');
    return () => checkAppleContainerAvailable();
  }
  return checkDockerAvailable;
}

async function resolveExplicit(
  agent: AgentId,
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources: CredentialSources | undefined,
  providerProfileName: string | undefined,
): Promise<PreflightResult> {
  if (agent === 'builtin') {
    return {
      mode: { kind: 'builtin' },
      reason: 'Explicit --agent builtin',
    };
  }

  return resolveDockerAgent(agent, config, isDockerAvailable, credentialSources, providerProfileName, {
    dockerUnavailable: (detailedMessage) =>
      `--agent ${agent} requires Docker, but it is not available:\n\n${detailedMessage}\n\n` +
      'Please fix your Docker installation or use the builtin agent.',
    credentialsMissing: (oauthOnly) => credentialErrorMessageForExplicit(agent, config, oauthOnly),
    successReason: (authKind) => `Explicit --agent selection (${authKindLabel(authKind)})`,
  });
}

async function resolveDefaultMode(
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources: CredentialSources | undefined,
  providerProfileName: string | undefined,
): Promise<PreflightResult> {
  const { preferredMode, preferredDockerAgent } = config.userConfig;

  if (preferredMode === 'builtin') {
    // Fail before the Docker probe — fast feedback for missing keys.
    const agentModelId = config.userConfig.agentModelId;
    const { provider } = parseModelId(agentModelId);
    const apiKey = resolveApiKeyForProvider(provider, config.userConfig);
    if (apiKey.length === 0) {
      throw new PreflightError(builtinNeedsApiKeyMessage(provider, agentModelId));
    }
    return { mode: { kind: 'builtin' }, reason: 'preferredMode = builtin' };
  }

  const agent = preferredDockerAgent as AgentId;

  return resolveDockerAgent(agent, config, isDockerAvailable, credentialSources, providerProfileName, {
    dockerUnavailable: dockerUnavailableMessage,
    credentialsMissing: (oauthOnly) => credentialErrorMessageForPreferredMode(agent, config, oauthOnly),
    successReason: (authKind) => `${preferredDockerAgent} (${authKindLabel(authKind)})`,
  });
}
