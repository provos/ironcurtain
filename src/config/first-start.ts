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
import { USER_CONFIG_DEFAULTS } from './user-config.js';
import { parseModelId, type ProviderId } from './model-provider.js';

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
  const requiredProviders = getRequiredProviders();
  let allPresent = true;
  for (const provider of requiredProviders) {
    const envVar = PROVIDER_ENV_VARS[provider];
    if (process.env[envVar]) {
      p.log.success(`API key configured for ${provider} (${envVar})`);
    } else {
      allPresent = false;
      p.log.warn(
        `Missing API key for ${provider}.\n` +
          `  Set it via: export ${envVar}=<your-key>\n` +
          `  Or add ${envVar}=<your-key> to a .env file in your project directory.`,
      );
    }
  }
  if (allPresent) {
    p.log.info('All required API keys are configured.');
  }

  // Step 4: Suggest customization
  p.note(
    'You can customize IronCurtain to fit your workflow:\n\n' +
      '  ironcurtain config             — change models, resource limits, and other settings\n' +
      '  ironcurtain customize-policy   — LLM-assisted interactive policy customization\n' +
      '  ironcurtain compile-policy     — recompile after constitution changes\n' +
      '  ironcurtain annotate-tools     — reclassify tool arguments after server changes',
    'Customization',
  );

  // Step 5: Outro
  p.outro('Run `ironcurtain start` to begin.');
}
