/**
 * Diagnostic check functions for `ironcurtain doctor`.
 *
 * Each check is a thin wrapper around an existing helper. Functions in
 * this module MUST NOT call process.exit — the entry point alone is
 * responsible for translating results into an exit code so unit tests
 * can call check functions directly without short-circuits.
 */

import { spawnSync } from 'node:child_process';
import { arch, platform } from 'node:os';
import { checkSandboxViability } from '../utils/preflight-checks.js';
import { checkDockerAvailable, type DockerAvailability } from '../docker/docker-probe.js';
import { checkAppleContainerAvailable } from '../docker/apple-container-manager.js';
import { resolveRuntimeKind, type ContainerRuntimeKind } from '../docker/container-runtime.js';
import { detectAuthMethod, readOnlyCredentialSources } from '../docker/oauth-credentials.js';
import {
  clampDockerResources,
  isImagePresent,
  probeDockerResources,
  type ClampedDockerResources,
  type ExecFileFn,
  type HostResources,
  type ProbeResult as ResourceProbeResult,
  type ResourceProbeBin,
} from '../docker/resource-limits.js';
import { getAgent, registerBuiltinAdapters } from '../docker/agent-registry.js';
import type { AgentId } from '../docker/agent-adapter.js';
import {
  resolveApiKeyForProvider,
  createLanguageModel,
  parseModelId,
  type ProviderId,
} from '../config/model-provider.js';
import { loadGeneratedPolicy, getPackageGeneratedDir, findAnnotationServerDrift, loadConfig } from '../config/index.js';
import { computeConstitutionHash } from '../config/paths.js';
import type { IronCurtainConfig, MCPServerConfig } from '../config/types.js';
import { isObjectWithProp } from '../utils/is-plain-object.js';
import { probeServer, type ProbeResult } from './mcp-liveness.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly message: string;
  /** Optional remediation suggestion shown indented under the result. */
  readonly hint?: string;
}

/**
 * Fully supported (tested) major lines: the even-numbered Node.js releases.
 * 24 and 26 ship prebuilt `isolated-vm` binaries; 22 source-compiles the V8
 * sandbox at install. In-range odd lines (23, 25) are non-LTS, ship no prebuilt
 * binary, and are not validated — they get a `warn`, not an `ok`.
 */
const SUPPORTED_MAJORS = [22, 24, 26];
/** Outer bounds — derived from SUPPORTED_MAJORS so they can't drift from it. */
const NODE_MIN_MAJOR = Math.min(...SUPPORTED_MAJORS);
const NODE_MAX_MAJOR = Math.max(...SUPPORTED_MAJORS);

export function checkNodeVersion(versionString: string = process.versions.node): CheckResult {
  const match = /^(\d+)\./.exec(versionString);
  const major = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(major)) {
    return {
      name: 'Node.js',
      status: 'fail',
      message: `unrecognized version "${versionString}"`,
      hint: `Install Node.js 22, 24, or 26 from https://nodejs.org/`,
    };
  }
  if (major < NODE_MIN_MAJOR || major > NODE_MAX_MAJOR) {
    return {
      name: 'Node.js',
      status: 'fail',
      message: `${versionString} (unsupported)`,
      hint:
        'IronCurtain supports Node.js 22, 24, or 26. ' +
        'Node 22 source-compiles the V8 sandbox (isolated-vm); 24 and 26 use prebuilt binaries.',
    };
  }
  if (!SUPPORTED_MAJORS.includes(major)) {
    return {
      name: 'Node.js',
      status: 'warn',
      message: `${versionString} (untested)`,
      hint:
        `Node ${major} is a non-LTS line IronCurtain doesn't test; ` +
        'isolated-vm ships no prebuilt binary for it and will source-compile. Prefer Node 22, 24, or 26.',
    };
  }
  return {
    name: 'Node.js',
    status: 'ok',
    message: versionString,
  };
}

export async function checkSandbox(): Promise<CheckResult> {
  const result = await checkSandboxViability();
  if (result.ok) {
    const note = result.message === 'cached' ? 'OK (cached)' : 'OK';
    return { name: 'V8 sandbox', status: 'ok', message: note };
  }
  return {
    name: 'V8 sandbox',
    status: 'fail',
    message: result.message,
    hint: result.details,
  };
}

/**
 * Reports Docker daemon status. Returns `warn` (not `fail`) on unavailability —
 * `checkPreferredMode` decides whether the warn is fatal based on the
 * user's `preferredMode`. Keeping this check semantically agnostic lets it
 * be reused in contexts that don't care about preferred mode.
 */
export async function checkDocker(
  probe: () => Promise<DockerAvailability> = checkDockerAvailable,
): Promise<CheckResult> {
  const status = await probe();
  if (status.available) {
    return { name: 'Docker', status: 'ok', message: 'running' };
  }
  return {
    name: 'Docker',
    status: 'warn',
    message: 'unavailable',
    hint: status.detailedMessage,
  };
}

/**
 * Reports Apple `container` runtime status. `skip` on platforms where the
 * backend is structurally unavailable (non-macOS, Intel, pre-macOS-26);
 * `warn` when the platform qualifies but the CLI/services are not ready —
 * `checkActiveRuntime` upgrades that to a fail when this backend is the
 * one sessions will actually use.
 */
export async function checkAppleContainer(
  probe: () => Promise<DockerAvailability> = checkAppleContainerAvailable,
  hostPlatform: string = platform(),
  hostArch: string = arch(),
): Promise<CheckResult> {
  if (hostPlatform !== 'darwin' || hostArch !== 'arm64') {
    return { name: 'Apple container', status: 'skip', message: 'not applicable (requires macOS on Apple silicon)' };
  }
  const status = await probe();
  if (status.available) {
    return { name: 'Apple container', status: 'ok', message: 'running' };
  }
  return {
    name: 'Apple container',
    status: status.reason.includes('macOS 26') ? 'skip' : 'warn',
    message: status.reason,
    hint: status.detailedMessage,
  };
}

/**
 * Reports whether Rosetta is installed. Only meaningful when the Apple
 * container backend is in play: its BuildKit builder VM requires Rosetta,
 * so agent-image builds fail without it. Probed by running an x86_64
 * binary under `arch` — exits 0 iff Rosetta can translate it.
 */
export function checkRosetta(
  runX86: () => boolean = () =>
    spawnSync('arch', ['-x86_64', '/usr/bin/true'], { stdio: 'ignore', timeout: 10_000 }).status === 0,
): CheckResult {
  if (runX86()) {
    return { name: 'Rosetta', status: 'ok', message: 'installed' };
  }
  return {
    name: 'Rosetta',
    status: 'warn',
    message: 'not installed — `container build` (agent images) will fail',
    hint: 'Install it with `softwareupdate --install-rosetta --agree-to-license`.',
  };
}

/** Output of checkActiveRuntime: the resolved backend plus its availability. */
export interface ActiveRuntime {
  readonly result: CheckResult;
  readonly kind: ContainerRuntimeKind;
  /** Human label for messages ("Docker" / "Apple container"). */
  readonly label: string;
  /** The availability CheckResult of the backend sessions will use. */
  readonly availability: CheckResult;
}

/**
 * Resolves which container runtime sessions will use (env override >
 * `containerRuntime` config > auto probe) and pairs it with the matching
 * availability result from the Environment section, so downstream checks
 * (preferred mode, resource limits) evaluate the backend that actually
 * runs — not unconditionally Docker.
 */
export async function checkActiveRuntime(
  config: IronCurtainConfig,
  dockerResult: CheckResult,
  appleResult: CheckResult,
): Promise<ActiveRuntime> {
  const configured = config.userConfig.containerRuntime;
  let kind: ContainerRuntimeKind;
  try {
    kind = await resolveRuntimeKind(configured);
  } catch (err) {
    // Invalid IRONCURTAIN_CONTAINER_RUNTIME value — sessions will throw too.
    return {
      result: {
        name: 'Container runtime',
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        hint: 'Unset IRONCURTAIN_CONTAINER_RUNTIME or set it to "docker" / "apple-container".',
      },
      kind: 'docker',
      label: 'Docker',
      availability: dockerResult,
    };
  }
  const label = kind === 'apple-container' ? 'Apple container' : 'Docker';
  const availability = kind === 'apple-container' ? appleResult : dockerResult;
  const source = process.env.IRONCURTAIN_CONTAINER_RUNTIME
    ? 'env override'
    : configured === 'auto'
      ? 'auto-detected'
      : 'config';
  return {
    result: { name: 'Container runtime', status: 'ok', message: `${kind} (${source})` },
    kind,
    label,
    availability,
  };
}

/**
 * Reports whether the user's `preferredMode` is satisfiable on this host.
 *
 * Reuses the prior `dockerResult` from `checkDocker` so Docker is probed
 * exactly once per `doctor` run. Maps the (preferredMode × dockerResult ×
 * api-key-presence) tuple to a status:
 *
 *   - preferredMode: 'docker' + Docker ok          -> ok
 *   - preferredMode: 'docker' + Docker unavailable -> fail (sessions will refuse to start)
 *   - preferredMode: 'builtin' + API key present   -> ok
 *   - preferredMode: 'builtin' + no API key        -> warn (sessions will fail to start by default)
 */
export function checkPreferredMode(
  config: IronCurtainConfig,
  dockerResult: CheckResult,
  runtimeLabel = 'Docker',
): CheckResult {
  const preferredMode = config.userConfig.preferredMode;

  if (preferredMode === 'docker') {
    if (dockerResult.status === 'ok') {
      return { name: 'Preferred mode', status: 'ok', message: 'docker' };
    }
    return {
      name: 'Preferred mode',
      status: 'fail',
      message: `docker, but ${runtimeLabel} is unavailable. Sessions will refuse to start.`,
      hint: `Start ${runtimeLabel}, or run \`ironcurtain config\` and set Session Mode > Preferred mode to "builtin".`,
    };
  }

  // preferredMode === 'builtin'
  const apiKey = resolveApiKeyForProvider('anthropic', config.userConfig);
  if (apiKey.length > 0) {
    return { name: 'Preferred mode', status: 'ok', message: 'builtin' };
  }
  return {
    name: 'Preferred mode',
    status: 'warn',
    message: 'builtin, but no ANTHROPIC_API_KEY configured. Sessions will fail.',
    hint: 'Set ANTHROPIC_API_KEY in your environment, or run `ironcurtain config`.',
  };
}

/**
 * Reports whether the user's Docker resource ceilings (after clamping)
 * are accepted by Docker. Two-step:
 *
 *   1. Clamp the configured `dockerResources` against host capacity. If
 *      clamping happened, mention it in the message so the user sees what
 *      they're actually getting.
 *   2. Resolve the preferred Docker agent's image. If it isn't present
 *      locally, skip the probe with status `ok` (we deliberately do NOT
 *      pull images from doctor). If it is present, run a tiny throwaway
 *      `docker run` to confirm Docker accepts the limits. Parse failures
 *      into actionable hints.
 *
 * Callers should only invoke this when `dockerResult.status === 'ok'`.
 *
 * Exported for testing; tests pass stubbed `execFile` and `resolveImage` deps.
 */
export interface CheckDockerResourcesDeps {
  readonly execFile?: ExecFileFn;
  readonly resolveImage?: (agentId: AgentId) => Promise<string>;
}

export async function checkDockerResources(
  config: IronCurtainConfig,
  deps: CheckDockerResourcesDeps = {},
  runtimeKind: ContainerRuntimeKind = 'docker',
): Promise<CheckResult> {
  const bin: ResourceProbeBin = runtimeKind === 'apple-container' ? 'container' : 'docker';
  const name = runtimeKind === 'apple-container' ? 'Container resource limits' : 'Docker resource limits';
  const clamp = clampDockerResources(config.userConfig.dockerResources);
  const summary = describeClamp(clamp);

  let image: string;
  try {
    image = await resolveAgentImage(config.userConfig.preferredDockerAgent, deps.resolveImage);
  } catch (err) {
    return {
      name,
      status: 'warn',
      message: `${summary}; could not resolve preferred-agent image`,
      hint: err instanceof Error ? err.message : String(err),
    };
  }

  // We deliberately do not pull images during a doctor run; if the image
  // isn't already on the host, the user hasn't started a session yet, so a
  // resource probe would just push work into the wrong command.
  if (!(await isImagePresent(image, deps.execFile, bin))) {
    return {
      name,
      status: 'ok',
      message: `${summary}; image ${image} not yet pulled — skipping probe`,
    };
  }

  const probe = await probeDockerResources(image, clamp.effective, deps.execFile, bin);
  const rejecter = runtimeKind === 'apple-container' ? 'Apple container' : 'Docker';
  return renderProbeResult(probe, summary, clamp.host, name, rejecter);
}

function describeClamp(clamp: ClampedDockerResources): string {
  const cpusLabel = clamp.effective.cpus === undefined ? 'unlimited' : `${clamp.effective.cpus} cpus`;
  const memLabel = clamp.effective.memoryMb === undefined ? 'unlimited' : `${clamp.effective.memoryMb} MB`;
  if (!clamp.clamped) {
    return `${cpusLabel}, ${memLabel}`;
  }
  // Report the pre-clamp values too so the user knows what they configured.
  const requestedCpus = clamp.requested.cpus === null ? 'unlimited' : `${clamp.requested.cpus} cpus`;
  const requestedMem = clamp.requested.memoryMb === null ? 'unlimited' : `${clamp.requested.memoryMb} MB`;
  return `${cpusLabel}, ${memLabel} (clamped from ${requestedCpus}, ${requestedMem} to fit host)`;
}

async function resolveAgentImage(
  agentId: AgentId | string,
  override?: (agentId: AgentId) => Promise<string>,
): Promise<string> {
  if (override) return override(agentId as AgentId);
  await registerBuiltinAdapters();
  return getAgent(agentId as AgentId).getImage();
}

function renderProbeResult(
  probe: ResourceProbeResult,
  summary: string,
  host: HostResources,
  name = 'Docker resource limits',
  rejecter = 'Docker',
): CheckResult {
  if (probe.ok) {
    return { name, status: 'ok', message: summary };
  }
  const suggested = probe.suggested ?? {};
  const hintParts: string[] = ['Run `ironcurtain config` and adjust Docker Agent > Container resources.'];
  if (suggested.cpus !== undefined) {
    hintParts.push(`Try cpus=${suggested.cpus}`);
  }
  if (suggested.memoryMb !== undefined) {
    hintParts.push(`Try memoryMb=${suggested.memoryMb}`);
  }
  // On macOS, the host snapshot can over-report what Docker Desktop's VM
  // will accept; surfacing it lets the user sanity-check against the VM's
  // allocation.
  hintParts.push(`(Host: ${host.cpus} cpus, ${host.memoryMb} MB.)`);
  return {
    name,
    status: 'fail',
    message: `${rejecter} rejected ${summary}: ${truncateForMessage(probe.stderr)}`,
    hint: hintParts.join(' '),
  };
}

function truncateForMessage(stderr: string): string {
  const cleaned = stderr.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 200) return cleaned;
  return `${cleaned.slice(0, 200)}…`;
}

export interface ConfigLoadOk {
  readonly result: CheckResult;
  readonly config: IronCurtainConfig;
}

export interface ConfigLoadFail {
  readonly result: CheckResult;
  readonly config: undefined;
}

/**
 * Loads ~/.ironcurtain/config.json and reports the outcome. Returns the
 * resolved config alongside the CheckResult so subsequent checks can
 * reuse it without re-loading.
 */
export function checkConfigLoad(): ConfigLoadOk | ConfigLoadFail {
  try {
    const config = loadConfig();
    return {
      result: { name: 'User config', status: 'ok', message: 'parsed cleanly' },
      config,
    };
  } catch (err) {
    return {
      result: {
        name: 'User config',
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        hint: 'Run `ironcurtain config` to fix configuration issues.',
      },
      config: undefined,
    };
  }
}

export interface PolicyLoadOk {
  readonly results: CheckResult[];
  readonly compiledPolicy: ReturnType<typeof loadGeneratedPolicy>['compiledPolicy'];
  readonly toolAnnotations: ReturnType<typeof loadGeneratedPolicy>['toolAnnotations'];
}

export interface PolicyLoadFail {
  readonly results: CheckResult[];
  readonly compiledPolicy: undefined;
  readonly toolAnnotations: undefined;
}

/**
 * Loads compiled-policy.json and tool-annotations.json. On success the
 * caller can run drift checks against the result; on failure both
 * artifacts are reported as missing/unparseable in a single CheckResult.
 */
export function checkPolicyArtifacts(config: IronCurtainConfig): PolicyLoadOk | PolicyLoadFail {
  try {
    const loaded = loadGeneratedPolicy({
      policyDir: config.generatedDir,
      toolAnnotationsDir: config.toolAnnotationsDir ?? config.generatedDir,
      fallbackDir: getPackageGeneratedDir(),
    });
    return {
      results: [{ name: 'Policy artifacts', status: 'ok', message: 'present and parseable' }],
      compiledPolicy: loaded.compiledPolicy,
      toolAnnotations: loaded.toolAnnotations,
    };
  } catch (err) {
    return {
      results: [
        {
          name: 'Policy artifacts',
          status: 'fail',
          message: err instanceof Error ? err.message : String(err),
          hint: 'Run `ironcurtain compile-policy` to (re)generate compiled-policy.json and tool-annotations.json.',
        },
      ],
      compiledPolicy: undefined,
      toolAnnotations: undefined,
    };
  }
}

/**
 * Compares the active constitution hash to the value baked into the
 * compiled policy. A mismatch means the constitution was edited without
 * recompiling.
 */
export function checkConstitutionDrift(
  config: IronCurtainConfig,
  compiledPolicy: { constitutionHash: string },
): CheckResult {
  let currentHash: string;
  try {
    currentHash = computeConstitutionHash(config.constitutionPath);
  } catch (err) {
    return {
      name: 'Compiled policy',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Verify that constitution.md exists at the configured location.',
    };
  }
  if (currentHash === compiledPolicy.constitutionHash) {
    return { name: 'Compiled policy', status: 'ok', message: 'fresh' };
  }
  return {
    name: 'Compiled policy',
    status: 'warn',
    message: 'constitution has changed since last compile',
    hint: 'Run `ironcurtain compile-policy` to update compiled-policy.json.',
  };
}

/**
 * Reports drift between configured MCP servers and tool-annotations.json.
 * Uses the pure helper findAnnotationServerDrift so output goes through
 * the doctor renderer rather than stderr.
 */
export function checkAnnotationDrift(
  toolAnnotations: Parameters<typeof findAnnotationServerDrift>[0],
  mcpServers: Record<string, MCPServerConfig>,
): CheckResult {
  const { missing, orphaned } = findAnnotationServerDrift(toolAnnotations, mcpServers);
  if (missing.length === 0 && orphaned.length === 0) {
    return { name: 'Tool annotations', status: 'ok', message: 'in sync with mcp-servers.json' };
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  if (orphaned.length > 0) parts.push(`orphaned: ${orphaned.join(', ')}`);
  const hint =
    missing.length > 0
      ? `Run \`ironcurtain annotate-tools --server ${missing[0]}\` for each missing server.`
      : 'Re-run `ironcurtain annotate-tools --all` to drop orphaned entries.';
  return {
    name: 'Tool annotations',
    status: 'warn',
    message: parts.join('; '),
    hint,
  };
}

/**
 * Reports per-MCP-server credential presence. Looks at:
 *   - `-e <VAR>` arguments (Docker convention used by mcp-servers.json)
 *   - keys of `config.env`
 * For each declared env var, the check passes if the value is set in
 * process.env, inline in serverConfig.env, or in serverCredentials[serverName].
 */
export function checkServerCredentials(
  serverName: string,
  serverConfig: MCPServerConfig,
  config: IronCurtainConfig,
): CheckResult {
  const required = collectDeclaredEnvVars(serverConfig);
  if (required.length === 0) {
    return { name: serverName, status: 'ok', message: 'no credentials required' };
  }
  const provided = config.userConfig.serverCredentials[serverName] ?? {};
  const inline = serverConfig.env ?? {};
  const missing = required.filter((name) => {
    const fromEnv = process.env[name];
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return false;
    const fromInline = inline[name];
    if (typeof fromInline === 'string' && fromInline.length > 0) return false;
    const fromCfg = provided[name];
    if (typeof fromCfg === 'string' && fromCfg.length > 0) return false;
    return true;
  });
  if (missing.length === 0) {
    return {
      name: serverName,
      status: 'ok',
      message: `${required.length} credential${required.length === 1 ? '' : 's'} set`,
    };
  }
  return {
    name: serverName,
    status: 'warn',
    message: `missing: ${missing.join(', ')}`,
    hint: 'Set the env var(s) or run `ironcurtain config` to store the credentials.',
  };
}

/**
 * Walks an MCP server config to collect declared env-var names from
 * `-e <NAME>` argument pairs and from the keys of `config.env`.
 */
export function collectDeclaredEnvVars(serverConfig: MCPServerConfig): string[] {
  const names = new Set<string>();
  for (let i = 0; i < serverConfig.args.length - 1; i++) {
    if (serverConfig.args[i] === '-e') {
      const candidate = serverConfig.args[i + 1];
      // Plain `-e VAR` (Docker forward) — skip `KEY=value` form because
      // those carry an inline value, not a host-env reference.
      if (typeof candidate === 'string' && !candidate.includes('=')) {
        names.add(candidate);
      }
    }
  }
  if (serverConfig.env) {
    for (const key of Object.keys(serverConfig.env)) {
      // Skip transport-style env vars that carry hard-coded values rather
      // than secrets. Only flag vars that are likely credential refs.
      if (looksLikeCredentialEnv(key)) {
        names.add(key);
      }
    }
  }
  return [...names].sort();
}

const CREDENTIAL_KEYWORDS = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'API'];

function looksLikeCredentialEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return CREDENTIAL_KEYWORDS.some((kw) => upper.includes(kw));
}

export interface ServerLivenessOptions {
  readonly probe?: typeof probeServer;
}

/**
 * Builds the per-server CheckResult based on whether the server's
 * declared credentials are present. Servers with missing credentials
 * are skipped (no spawn) to avoid spurious failures.
 */
export async function checkMcpServerLiveness(
  config: IronCurtainConfig,
  options: ServerLivenessOptions = {},
): Promise<CheckResult[]> {
  const probe = options.probe ?? probeServer;
  const entries = Object.entries(config.mcpServers);
  if (entries.length === 0) {
    return [
      {
        name: '(no servers configured)',
        status: 'skip',
        message: 'mcp-servers.json contains no entries',
      },
    ];
  }

  const tasks = entries.map(async ([name, serverConfig]): Promise<CheckResult> => {
    if (checkServerCredentials(name, serverConfig, config).status === 'warn') {
      return { name, status: 'skip', message: 'skipped — missing creds' };
    }
    const result = await probe(name, serverConfig, config.userConfig.serverCredentials[name] ?? {});
    return formatProbeResult(name, result);
  });

  return Promise.all(tasks);
}

function formatProbeResult(name: string, result: ProbeResult): CheckResult {
  if (result.status === 'ok') {
    const elapsed = formatElapsed(result.elapsedMs);
    return { name, status: 'ok', message: `${result.toolCount} tool${result.toolCount === 1 ? '' : 's'}, ${elapsed}` };
  }
  return {
    name,
    status: 'fail',
    message: `failed after ${formatElapsed(result.elapsedMs)}`,
    hint: result.reason,
  };
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Runs a 1-token generateText call against the configured agent model,
 * checking the API key for that model's provider (which may not be
 * Anthropic — IronCurtain supports OpenAI and Google too).
 */
export async function checkAgentApiRoundtrip(config: IronCurtainConfig): Promise<CheckResult> {
  const { provider } = parseModelId(config.agentModelId);
  const label = formatProviderLabel(provider);
  const name = `${label} API round-trip`;
  const apiKey = resolveApiKeyForProvider(provider, config.userConfig);
  if (apiKey.length === 0) {
    if (provider === 'anthropic' && (await detectAuthMethod(config, readOnlyCredentialSources)).kind === 'oauth') {
      return {
        name,
        status: 'skip',
        message: 'OAuth-only setup — covered by OAuth refresh check below',
      };
    }
    return {
      name,
      status: 'skip',
      message: `no ${label} API key — round-trip uses API key auth only`,
    };
  }
  try {
    const start = Date.now();
    // Lazy-import the AI SDK so the default doctor run doesn't pay the load cost.
    const { generateText } = await import('ai');
    const model = await createLanguageModel(config.agentModelId, config.userConfig);
    await generateText({
      model,
      prompt: 'Reply with the single word OK.',
      maxOutputTokens: 1,
      // Cap the round-trip so a network blackhole or DNS stall can't hang
      // doctor. maxRetries: 0 turns off the SDK's default 3-attempt retry —
      // for diagnostics we want fast failure, not eventual failure.
      abortSignal: AbortSignal.timeout(API_ROUNDTRIP_TIMEOUT_MS),
      maxRetries: 0,
    });
    const elapsed = formatElapsed(Date.now() - start);
    return { name, status: 'ok', message: `responded in ${elapsed}` };
  } catch (err) {
    return {
      name,
      status: 'fail',
      message: describeApiError(err),
      hint: `Verify the ${label} API key is valid and the configured agentModelId exists.`,
    };
  }
}

/** Hard cap on the agent-model API round-trip; healthy calls are 1-3s. */
const API_ROUNDTRIP_TIMEOUT_MS = 15_000;

/**
 * Renders an AI SDK error with as much diagnostic info as we can extract.
 * The SDK's APICallError frequently has an empty .message but a useful
 * .url and .cause (the underlying fetch error). Surface all of them so
 * "Cannot connect to API:" doesn't lose the actual reason.
 */
function describeApiError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  if (err.message) parts.push(err.message);
  // AI SDK APICallError surfaces the URL it tried to hit.
  if (isObjectWithProp(err, 'url') && typeof err.url === 'string' && err.url.length > 0) {
    parts.push(`url=${err.url}`);
  }
  // Status code from APICallError.
  if (isObjectWithProp(err, 'statusCode') && typeof err.statusCode === 'number') {
    parts.push(`status=${err.statusCode}`);
  }
  // Underlying cause (e.g., fetch's TypeError with the system error code).
  if (isObjectWithProp(err, 'cause')) {
    const cause = err.cause;
    if (cause instanceof Error && cause.message) {
      parts.push(`cause=${cause.message}`);
      if (isObjectWithProp(cause, 'code') && typeof cause.code === 'string') {
        parts.push(`code=${cause.code}`);
      }
    } else if (typeof cause === 'string') {
      parts.push(`cause=${cause}`);
    }
  }
  return parts.join(' | ');
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

function formatProviderLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider];
}
