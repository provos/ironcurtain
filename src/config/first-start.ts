/**
 * First-start wizard for IronCurtain.
 *
 * Runs once when ~/.ironcurtain/config.json does not yet exist,
 * educating the user about the security model, validating API keys,
 * and pointing to customization options.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import {
  USER_CONFIG_DEFAULTS,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_PROVIDER_LABELS,
  WEB_SEARCH_PROVIDER_URLS,
  loadUserConfig,
  saveUserConfig,
  type ResolvedDockerResourcesConfig,
  type UserConfig,
  type WebSearchProvider,
} from './user-config.js';
import { parseModelId, type ProviderId } from './model-provider.js';
import {
  clampDockerResources,
  isImagePresent,
  probeDockerResources,
  DOCKER_MIN_CPUS,
  DOCKER_MIN_MEMORY_MB,
} from '../docker/resource-limits.js';
import { getAgent, registerBuiltinAdapters } from '../docker/agent-registry.js';
import type { AgentId } from '../docker/agent-adapter.js';
import { checkDockerAvailable } from '../session/preflight.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Maps provider IDs to their expected environment variable names. */
const PROVIDER_ENV_VARS: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Checks if a prompt result was cancelled and exits cleanly. */
function handleCancel(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
}

/**
 * Strips credentials/query and renders only `scheme://host[:port]` for log display.
 * Falls back to the raw string when not a parseable URL.
 */
function sanitizeBaseUrlForDisplay(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
  } catch {
    return raw;
  }
}

/**
 * Extracts the set of unique providers required by the default model configuration.
 */
function getRequiredProviders(): Set<ProviderId> {
  const modelIds = [
    USER_CONFIG_DEFAULTS.agentModelId,
    USER_CONFIG_DEFAULTS.policyModelId,
    USER_CONFIG_DEFAULTS.autoCompact.summaryModelId,
    USER_CONFIG_DEFAULTS.autoApprove.modelId,
  ];
  const providers = new Set<ProviderId>();
  for (const id of modelIds) {
    providers.add(parseModelId(id).provider);
  }
  return providers;
}

export async function runFirstStart(): Promise<void> {
  // Step 1: Welcome & security philosophy
  p.intro('Welcome to IronCurtain');
  p.note(
    'In theater, an iron curtain is a fireproof barrier between the stage and\n' +
      'the audience. If something goes wrong on stage, the curtain drops to\n' +
      'contain the disaster. That is the metaphor.\n\n' +
      'AI agents today operate under your full authority. They hold your\n' +
      'credentials, process untrusted input, and execute code — all in the\n' +
      'same trust domain. A single prompt injection can cause an agent to\n' +
      'exfiltrate your data, and the agent has every capability to do so.',
    'The problem',
  );
  p.note(
    'IronCurtain mediates every tool call between the AI agent and MCP servers.\n' +
      'A policy engine evaluates each call against a constitution you control.\n' +
      'The agent can only produce typed function calls from a V8 isolate.\n' +
      'Each MCP server runs in its own OS-level sandbox.\n\n' +
      'We assume the LLM will be compromised or confused and constrain the\n' +
      'consequences through architecture — not prevention.\n\n' +
      'A word of caution: when you read "secure," mistrust it. There is a\n' +
      'strong tension between security and utility. IronCurtain limits major\n' +
      'unintended consequences but cannot guarantee nothing unintended will\n' +
      'happen. The policy and sandbox constraints are there to limit the damage.',
    'How IronCurtain helps',
  );

  const cont = await p.confirm({ message: 'Continue with setup?', initialValue: true });
  handleCancel(cont);
  if (!cont) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // Load existing config without creating or modifying config.json
  let existingConfig;
  try {
    existingConfig = loadUserConfig({ readOnly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(`Error loading config: ${message}`);
    p.log.info('Fix the config file or delete it and re-run setup.');
    process.exit(1);
  }

  // Accumulate all wizard choices, saved once at the end
  const pending: UserConfig = {};

  // Step 2: Show the default constitution
  const constitutionPath = resolve(__dirname, 'constitution.md');
  let constitutionText: string;
  try {
    constitutionText = readFileSync(constitutionPath, 'utf-8');
  } catch {
    constitutionText = '(Could not read default constitution)';
  }
  p.note(constitutionText, 'Default Constitution');

  // Step 3: API key validation
  // The Anthropic credential can be satisfied two ways: a direct API key
  // (ANTHROPIC_API_KEY) or a bearer auth token for an Anthropic-compatible
  // gateway like OpenRouter or LiteLLM (ANTHROPIC_AUTH_TOKEN + optional
  // ANTHROPIC_BASE_URL). Don't warn about ANTHROPIC_API_KEY if the user
  // has the gateway path configured.
  //
  // Note: this is an env-only check used during first-start onboarding.
  // Values stored in `~/.ironcurtain/config.json` are accepted by
  // `resolveAnthropicAuth` at session start, so an empty env block here
  // does not mean the user has no credential — only that they haven't
  // exported one in the current shell. The downstream session preflight
  // (`resolveSessionMode`) does the authoritative gate.
  const requiredProviders = getRequiredProviders();
  let allPresent = true;
  for (const provider of requiredProviders) {
    const envVar = PROVIDER_ENV_VARS[provider];
    if (process.env[envVar]) {
      p.log.success(`API key configured for ${provider} (${envVar})`);
      continue;
    }
    if (provider === 'anthropic' && process.env.ANTHROPIC_AUTH_TOKEN) {
      const baseUrlHint = process.env.ANTHROPIC_BASE_URL
        ? ` (routing to ${sanitizeBaseUrlForDisplay(process.env.ANTHROPIC_BASE_URL)})`
        : '';
      p.log.success(`Anthropic auth token configured (ANTHROPIC_AUTH_TOKEN)${baseUrlHint}`);
      continue;
    }
    allPresent = false;
    const extraHint =
      provider === 'anthropic'
        ? '\n  Or for OpenRouter / Anthropic-compatible gateway:\n' +
          '    export ANTHROPIC_AUTH_TOKEN=<token>\n' +
          '    export ANTHROPIC_BASE_URL=<gateway-url>  # optional'
        : '';
    p.log.warn(
      `Missing API key for ${provider}.\n` +
        `  Set it via: export ${envVar}=<your-key>\n` +
        `  Or add ${envVar}=<your-key> to a .env file in your project directory.${extraHint}`,
    );
  }
  if (allPresent) {
    p.log.info('All required API keys are configured.');
  }

  // Step 4: Optional web search provider
  p.log.info(
    'Web search lets the agent look up documentation, error messages, and current\n' +
      'information. This is optional but makes the agent significantly more helpful.',
  );
  const existingProvider = existingConfig.webSearch.provider;
  const providerOptions = WEB_SEARCH_PROVIDERS.map((prov) => ({
    value: prov,
    label: WEB_SEARCH_PROVIDER_LABELS[prov],
    hint: prov === existingProvider ? `${WEB_SEARCH_PROVIDER_URLS[prov]} (configured)` : WEB_SEARCH_PROVIDER_URLS[prov],
  }));
  const setupSearch = await p.select({
    message: 'Set up a web search provider?',
    options: [
      ...providerOptions,
      { value: 'skip' as const, label: 'Skip for now', hint: 'configure later via ironcurtain config' },
    ],
    initialValue: existingProvider || undefined,
  });
  handleCancel(setupSearch);

  if (setupSearch !== 'skip') {
    const provider = setupSearch as WebSearchProvider;
    const existingKey = existingConfig.webSearch[provider]?.apiKey;
    if (existingKey) {
      // Re-selected a provider that already has an API key — preserve it
      p.log.success(`Existing ${provider} API key preserved.`);
      pending.webSearch = { provider };
    } else {
      const apiKey = await p.text({
        message: `Enter your ${provider} API key:`,
        validate: (val) => (!val ? 'API key is required' : undefined),
      });
      handleCancel(apiKey);
      pending.webSearch = { provider, [provider]: { apiKey: apiKey as string } };
      p.log.success(`Web search configured with ${provider}.`);
    }
  }

  // Step 5: Optional GitHub personal access token
  p.log.info(
    'The GitHub MCP server lets the agent interact with GitHub (issues, PRs, code search).\n' +
      'This requires a personal access token. You can skip this and configure it later\n' +
      'via `ironcurtain config` or by editing config.json directly.',
  );
  const githubCreds = existingConfig.serverCredentials.github as Record<string, string> | undefined;
  const existingGhToken = githubCreds?.GITHUB_PERSONAL_ACCESS_TOKEN;
  const setupGithub = await p.confirm({
    message: existingGhToken ? 'Update GitHub personal access token?' : 'Configure GitHub personal access token?',
    initialValue: false,
  });
  handleCancel(setupGithub);

  if (setupGithub) {
    p.note(
      'Create a classic token at https://github.com/settings/tokens/new\n' + 'Required scopes: repo, read:org',
      'GitHub Token',
    );
    const ghToken = await p.text({
      message: 'GitHub personal access token:',
      placeholder: existingGhToken ? '(keep current)' : 'ghp_...',
      validate: (val) => {
        if (!val && !existingGhToken) return 'Token is required';
        return undefined;
      },
    });
    handleCancel(ghToken);
    const tokenValue = (ghToken as string) || existingGhToken;
    if (tokenValue) {
      pending.serverCredentials = {
        ...pending.serverCredentials,
        github: { ...(githubCreds ?? {}), GITHUB_PERSONAL_ACCESS_TOKEN: tokenValue },
      };
    }
  }

  // Step 6: Auto-approve for escalations
  p.log.info(
    'When the policy engine escalates a tool call, you are asked to approve or deny it.\n' +
      'Auto-approve uses a small LLM to approve calls that clearly match your explicit request.\n' +
      'It is conservative: any ambiguity is escalated to you for manual review.\n' +
      'The conservative choice is to leave it off and approve all escalations manually.',
  );
  const enableAutoApprove = await p.confirm({
    message: 'Enable auto-approve for escalations?',
    initialValue: existingConfig.autoApprove.enabled,
  });
  handleCancel(enableAutoApprove);
  pending.autoApprove = { enabled: enableAutoApprove as boolean };

  await maybeOfferDockerResourceFix(pending);

  // Persist all wizard choices in a single write
  saveUserConfig(pending);

  // Step 7: Suggest customization
  p.note(
    'You can customize IronCurtain to fit your workflow:\n\n' +
      '  ironcurtain config             — change models, resource limits, and other settings\n' +
      '  ironcurtain customize-policy   — LLM-assisted interactive policy customization\n' +
      '  ironcurtain compile-policy     — recompile after constitution changes\n' +
      '  ironcurtain annotate-tools     — reclassify tool arguments after server changes\n\n' +
      'Personas give your agent a named identity with its own workspace, policy,\n' +
      'and persistent memory. Create one with:\n\n' +
      '  ironcurtain persona create <name>',
    'Customization',
  );

  // Step 8: Outro
  p.outro('Run `ironcurtain start` to begin.');
}

/**
 * If Docker is up and the preferred-agent image is already cached locally,
 * runs a tiny `docker run` against the configured (default) resource
 * ceilings. On parsed failure (e.g. "Range of CPUs is from 0.01 to 2.00"),
 * surfaces the suggested values and offers to write them into `pending`.
 *
 * Silently skipped in all other cases: no Docker, no image, no parsed
 * suggestion, or user declines. Never blocks setup completion.
 */
async function maybeOfferDockerResourceFix(pending: UserConfig): Promise<void> {
  const dockerStatus = await checkDockerAvailable();
  if (!dockerStatus.available) return;

  // First-start runs before the user picks an agent, so resolve the same
  // default as `resolveUserConfig`.
  await registerBuiltinAdapters();
  let image: string;
  try {
    image = await getAgent('claude-code' as AgentId).getImage();
  } catch {
    return;
  }
  if (!(await isImagePresent(image))) return;

  const configured: ResolvedDockerResourcesConfig = {
    memoryMb: USER_CONFIG_DEFAULTS.dockerResources.memoryMb,
    cpus: USER_CONFIG_DEFAULTS.dockerResources.cpus,
  };
  const { effective, host, clamped } = clampDockerResources(configured);
  const probe = await probeDockerResources(image, effective);
  if (probe.ok) return;

  const suggested = probe.suggested ?? {};
  const cpuTarget = suggested.cpus ?? Math.max(DOCKER_MIN_CPUS, host.cpus > 1 ? host.cpus - 1 : DOCKER_MIN_CPUS);
  const memoryTarget = suggested.memoryMb ?? Math.max(DOCKER_MIN_MEMORY_MB, Math.floor(host.memoryMb * 0.75));

  const clampNote = clamped ? '(Auto-clamp already lowered the defaults but Docker still rejected them.)\n' : '';
  const summary =
    `Docker rejected the default container resource limits.\n\n` +
    `  Detected host: ${host.cpus} cpus, ${host.memoryMb} MB total\n` +
    `  Probe error:   ${probe.stderr.replace(/\s+/g, ' ').trim().slice(0, 200)}\n\n` +
    `Suggested settings: cpus=${cpuTarget}, memoryMb=${memoryTarget}\n` +
    clampNote;

  p.note(summary, 'Docker resources');

  const apply = await p.confirm({
    message: 'Save the suggested Docker resource settings to your config?',
    initialValue: true,
  });
  handleCancel(apply);
  if (apply !== true) return;

  pending.dockerResources = {
    ...(pending.dockerResources ?? {}),
    cpus: cpuTarget,
    memoryMb: memoryTarget,
  };
  p.log.success(`Docker resources updated: cpus=${cpuTarget}, memoryMb=${memoryTarget}`);
}
