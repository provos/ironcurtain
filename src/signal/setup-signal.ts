/**
 * Interactive Signal onboarding wizard.
 *
 * Implements `ironcurtain setup-signal` with two modes:
 * - Full setup: Docker check, container start, registration,
 *   recipient identity verification, and config save.
 * - Re-trust (`--re-trust`): Re-verify a changed identity key without
 *   repeating the full registration flow.
 *
 * Uses @clack/prompts for consistent terminal UI with other IronCurtain
 * interactive commands (config, first-start).
 */

import { randomInt } from 'node:crypto';
import { exec as execCb } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as p from '@clack/prompts';
import { createDockerManager } from '../docker/docker-manager.js';
import { saveUserConfig, loadUserConfig } from '../config/user-config.js';
import {
  createSignalContainerManager,
  type SignalContainerManager,
  type SignalContainerConfig,
} from './signal-container.js';
import { SIGNAL_DEFAULTS, resolveSignalConfig, getSignalDataDir } from './signal-config.js';
import type { DockerManager } from '../docker/types.js';

const execAsync = promisify(execCb);

// ---- Cancel handling ------------------------------------------------

/** Checks if a prompt result was cancelled and exits cleanly. */
function handleCancel(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
}

// ---- Phone number validation ----------------------------------------

const E164_REGEX = /^\+\d{7,15}$/;

/** Validates a phone number in E.164 format. Returns error string or undefined. */
export function validatePhoneNumber(value: string | undefined): string | undefined {
  if (!value) return 'Phone number is required';
  if (!E164_REGEX.test(value)) {
    return 'Must be E.164 format: +<country code><number> (e.g., +15551234567)';
  }
  return undefined;
}

// ---- Docker validation ----------------------------------------------

async function validateDocker(docker: DockerManager): Promise<void> {
  const spinner = p.spinner();
  spinner.start('Checking Docker...');

  try {
    await docker.preflight(SIGNAL_DEFAULTS.image);
    spinner.stop('Docker is available');
  } catch {
    // preflight checks both docker info and image -- we only need docker info here
    try {
      // Check if Docker daemon is reachable at all
      await execAsync('docker info', { timeout: 10_000 });
      spinner.stop('Docker is available');
    } catch {
      spinner.stop('Docker is not available');
      p.log.error(
        'Docker is not available. Start Docker and try again.\n\n' +
          'Install Docker: https://docs.docker.com/get-docker/',
      );
      process.exit(1);
    }
  }
}

// ---- Container setup ------------------------------------------------

function resolveContainerConfig(): SignalContainerConfig {
  return {
    image: SIGNAL_DEFAULTS.image,
    port: SIGNAL_DEFAULTS.port,
    dataDir: getSignalDataDir(),
    containerName: SIGNAL_DEFAULTS.containerName,
  };
}

async function startContainer(
  manager: SignalContainerManager,
  containerConfig: SignalContainerConfig,
): Promise<string> {
  const startSpinner = p.spinner();
  startSpinner.start('Starting signal-cli container (pulling image if needed)...');
  try {
    const baseUrl = await manager.ensureRunning();
    startSpinner.stop(`Container started on port ${containerConfig.port}`);

    const healthSpinner = p.spinner();
    healthSpinner.start('Waiting for signal-cli to become healthy...');
    try {
      await manager.waitForHealthy(baseUrl);
      healthSpinner.stop('Health check passed');
    } catch (err) {
      healthSpinner.stop('Health check failed');
      p.log.error(`signal-cli container did not become healthy: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    return baseUrl;
  } catch (err) {
    startSpinner.stop('Container start failed');
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('port') && message.includes('already')) {
      p.log.error(
        `Port ${containerConfig.port} is already in use.\n` +
          'Either stop the conflicting service or configure a different port\n' +
          'in ~/.ironcurtain/config.json under signal.container.port.',
      );
    } else {
      p.log.error(`Failed to start container: ${message}`);
    }
    process.exit(1);
  }
}

// ---- Account discovery -----------------------------------------------

async function fetchAccounts(baseUrl: string): Promise<string[]> {
  try {
    const resp = await fetch(`${baseUrl}/v1/accounts`);
    if (!resp.ok) return [];
    const accounts = (await resp.json()) as string[];
    if (accounts.length > 0) return accounts;
  } catch {
    // Fall through to local check
  }

  // Fallback: in json-rpc mode, signal-cli loads accounts at startup.
  // If registration happened after the container started, the REST API
  // won't know about the account until a restart. Check the host data
  // directory directly.
  return readAccountsFromDataDir();
}

/**
 * Reads accounts directly from signal-cli's accounts.json on the host.
 * This catches accounts the REST API doesn't see (json-rpc mode startup race).
 */
function readAccountsFromDataDir(): string[] {
  try {
    const accountsPath = resolve(getSignalDataDir(), 'data', 'accounts.json');
    const data = JSON.parse(readFileSync(accountsPath, 'utf-8')) as {
      accounts?: Array<{ number?: string }>;
    };
    return (data.accounts ?? []).map((a) => a.number).filter((n): n is string => !!n);
  } catch {
    return [];
  }
}

// ---- Registration flow ----------------------------------------------

/**
 * Registers a new phone number with Signal via the signal-cli REST API.
 * Handles the captcha and SMS verification code flow.
 */
export async function registerNewNumber(baseUrl: string): Promise<string> {
  const phoneNumber = await p.text({
    message: 'Enter the phone number to register (with country code):',
    placeholder: '+15551234567',
    validate: validatePhoneNumber,
  });
  handleCancel(phoneNumber);

  // Direct the user to the captcha page
  const captchaUrl = 'https://signalcaptchas.org/registration/generate.html';
  p.log.info(
    'To complete registration, Signal requires a captcha.\n' +
      'Open this URL in your browser:\n\n' +
      `  ${captchaUrl}\n\n` +
      'After completing the captcha, right-click the "Open Signal"\n' +
      'button and copy the link. It will start with signalcaptcha://\n' +
      'Paste the full link below.',
  );

  const captchaRaw = await p.text({
    message: 'Paste the captcha link:',
    validate: (v) => (v?.includes('signalcaptcha://') ? undefined : 'Must contain signalcaptcha://'),
  });
  handleCancel(captchaRaw);

  // Strip the signalcaptcha:// prefix - signal-cli expects just the token
  const captcha = (captchaRaw as string).replace(/^signalcaptcha:\/\//, '');

  // POST /v1/register/{number}
  const registerSpinner = p.spinner();
  registerSpinner.start(`Registering ${phoneNumber as string}...`);

  const registerResp = await fetch(`${baseUrl}/v1/register/${encodeURIComponent(phoneNumber as string)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ captcha }),
  });
  if (!registerResp.ok) {
    registerSpinner.stop('Registration failed');
    const body = await registerResp.text();
    if (registerResp.status === 400) {
      p.log.error(`Captcha rejected by Signal. Please try again with a new captcha.\n` + `Server response: ${body}`);
    } else {
      p.log.error(`Registration failed: ${registerResp.status} ${body}`);
    }
    throw new Error(`Registration failed: ${registerResp.status} ${body}`);
  }
  registerSpinner.stop('Registration request sent');

  // SMS verification code
  const verifyCode = await p.text({
    message: 'Enter the verification code from SMS:',
    validate: (v) => (v && /^\d{3}-?\d{3}$/.test(v) ? undefined : 'Enter 6-digit code (e.g., 123-456)'),
  });
  handleCancel(verifyCode);

  const normalizedCode = (verifyCode as string).replace('-', '');

  // POST /v1/register/{number}/verify/{code}
  const verifySpinner = p.spinner();
  verifySpinner.start('Verifying...');

  const verifyResp = await fetch(
    `${baseUrl}/v1/register/${encodeURIComponent(phoneNumber as string)}/verify/${normalizedCode}`,
    { method: 'POST' },
  );
  if (!verifyResp.ok) {
    verifySpinner.stop('Verification failed');
    const body = await verifyResp.text();
    p.log.error(`Verification failed: ${verifyResp.status} ${body}`);
    throw new Error(`Verification failed: ${verifyResp.status} ${body}`);
  }

  verifySpinner.stop('Phone number verified!');
  return phoneNumber as string;
}

// ---- Challenge-response identity verification -----------------------

/** Response shape from signal-cli's identity endpoint. */
interface SignalIdentity {
  number: string;
  safety_number: string;
  fingerprint: string;
  added: string;
  status: string;
}

/**
 * Sends a random challenge code to the recipient via Signal,
 * waits for the user to type it into the terminal, then
 * captures and returns the recipient's identity key.
 *
 * The identity key comes from signal-cli's identity endpoint
 * after a successful message exchange has occurred.
 */
export async function verifyRecipientIdentity(
  baseUrl: string,
  botNumber: string,
  recipientNumber: string,
): Promise<string> {
  const challengeCode = String(randomInt(100000, 999999));

  // Send the challenge via Signal
  p.log.info('A 6-digit challenge code has been sent to your Signal app.');
  const sendResp = await fetch(`${baseUrl}/v2/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `IronCurtain identity verification.\nYour challenge code is: ${challengeCode}`,
      number: botNumber,
      recipients: [recipientNumber],
    }),
  });
  if (!sendResp.ok) {
    throw new Error(`Failed to send challenge message: ${sendResp.status}`);
  }

  // Prompt user to enter the code they received
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    const entered = await p.text({
      message: 'Enter the challenge code from your Signal app:',
      validate: (v) => (v && /^\d{6}$/.test(v) ? undefined : 'Enter the 6-digit code'),
    });
    handleCancel(entered);

    if (entered === challengeCode) {
      break;
    }

    attempts++;
    if (attempts >= maxAttempts) {
      throw new Error(
        'Challenge verification failed after 3 attempts. ' +
          'Ensure you are reading the code from the correct Signal conversation.',
      );
    }
    p.log.warn(`Incorrect code. ${maxAttempts - attempts} attempt(s) remaining.`);
  }

  // Capture the recipient's identity key from signal-cli
  return fetchIdentityKey(baseUrl, botNumber, recipientNumber);
}

/**
 * Fetches the recipient's identity key from signal-cli's trust store.
 * Retries once after a short delay if the key is not yet available
 * (signal-cli may need time to process the message exchange).
 */
async function fetchIdentityKey(baseUrl: string, botNumber: string, recipientNumber: string): Promise<string> {
  const fetchKey = async (): Promise<string | null> => {
    // The per-recipient endpoint (/v1/identities/{bot}/{recipient}) is not
    // available in all versions. Use the all-identities endpoint and filter.
    const resp = await fetch(`${baseUrl}/v1/identities/${encodeURIComponent(botNumber)}`);
    if (!resp.ok) return null;

    const identities = (await resp.json()) as SignalIdentity[];
    const match = identities.find((id) => id.number === recipientNumber);
    if (!match) return null;

    // Fingerprint may contain spaces (e.g., "05 a1 b2 ...") - normalize to compact hex
    return match.fingerprint.replace(/\s+/g, '');
  };

  let fingerprint = await fetchKey();
  if (!fingerprint) {
    // Retry after a short delay - signal-cli may still be processing
    await new Promise((resolve) => setTimeout(resolve, 2000));
    fingerprint = await fetchKey();
  }

  if (!fingerprint) {
    throw new Error(
      'Identity key could not be retrieved. ' +
        'This may indicate signal-cli has not yet exchanged keys with the recipient.',
    );
  }

  p.log.success(
    `Identity verified! Signal identity key recorded.\n` + `  Fingerprint: ${fingerprint.substring(0, 20)}...`,
  );

  return fingerprint;
}

// ---- Re-trust flow --------------------------------------------------

/**
 * Re-verifies a changed identity key without repeating full registration.
 * Used when the transport detects an identity key change at runtime.
 */
export async function runReTrust(): Promise<void> {
  p.intro('Signal Identity Re-verification');

  const userConfig = loadUserConfig();
  const signalConfig = resolveSignalConfig(userConfig);

  if (!signalConfig) {
    p.log.error('Signal is not configured. Run: ironcurtain setup-signal');
    process.exit(1);
  }

  const { botNumber, recipientNumber, recipientIdentityKey: previousKey } = signalConfig;
  const baseUrl = `http://127.0.0.1:${signalConfig.container.port}`;

  p.note(
    `The Signal identity key for ${recipientNumber} has changed.\n` +
      'This can happen when:\n' +
      '  - You re-installed Signal\n' +
      '  - You switched to a new phone\n' +
      '  - Someone else has taken over the phone number\n\n' +
      'To re-establish trust, a new challenge code will be sent.',
    'Identity changed',
  );

  // Verify the container is running before attempting to send
  const docker = createDockerManager();
  const containerManager = createSignalContainerManager(docker, signalConfig.container);
  if (!(await containerManager.isRunning())) {
    const startSpinner = p.spinner();
    startSpinner.start('Starting signal-cli container...');
    try {
      await containerManager.ensureRunning();
      await containerManager.waitForHealthy(baseUrl);
      startSpinner.stop('Container started');
    } catch (err) {
      startSpinner.stop('Failed to start container');
      p.log.error(`Could not start signal-cli container: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  const newKey = await verifyRecipientIdentity(baseUrl, botNumber, recipientNumber);

  // Save the new identity key
  saveUserConfig({
    signal: {
      botNumber,
      recipientNumber,
      recipientIdentityKey: newKey,
    },
  });

  p.note(
    `Previous key: ${previousKey.substring(0, 20)}...\n` + `New key:      ${newKey.substring(0, 20)}...`,
    'Key updated',
  );

  p.outro('Transport unlocked. Sessions will now accept messages.');
}

// ---- Main setup wizard ----------------------------------------------

/**
 * Runs the interactive Signal setup wizard.
 *
 * Steps:
 * 1. Validate Docker availability
 * 2. Pull and start signal-cli container
 * 3. Register new number (or reuse existing account)
 * 4. Configure recipient number
 * 5. Challenge-response identity verification
 * 6. Capture and store identity key
 * 7. Save config
 */
export async function runSignalSetup(options?: { reTrust?: boolean }): Promise<void> {
  if (options?.reTrust) {
    await runReTrust();
    return;
  }

  p.intro('Signal Transport Setup');

  p.note(
    'Signal lets you interact with IronCurtain sessions from your\n' +
      'phone. The communication channel is end-to-end encrypted and\n' +
      'securely paired between the bot and your phone.\n\n' +
      "You'll need:\n" +
      '  - Docker running on this machine\n' +
      '  - A dedicated phone number for the bot\n' +
      '  - Your own Signal phone number (to receive messages)',
    'What is this?',
  );

  const cont = await p.confirm({ message: 'Continue with setup?', initialValue: true });
  handleCancel(cont);
  if (!cont) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // Step 1: Docker check
  const docker = createDockerManager();
  await validateDocker(docker);

  // Step 2: Pull image and start container
  const containerConfig = resolveContainerConfig();
  const manager = createSignalContainerManager(docker, containerConfig);
  const baseUrl = await startContainer(manager, containerConfig);

  // Step 3: Check for existing accounts, then register
  let botNumber: string;

  const existingAccounts = await fetchAccounts(baseUrl);
  if (existingAccounts.length > 0) {
    const useExisting = await p.select({
      message: `Found existing account: ${existingAccounts.join(', ')}. What would you like to do?`,
      options: [
        { value: 'use', label: `Use ${existingAccounts[0]}`, hint: 'skip registration' },
        { value: 'register', label: 'Register a new phone number' },
      ],
    });
    handleCancel(useExisting);

    if (useExisting === 'use') {
      botNumber = existingAccounts[0];
      p.log.success(`Using existing account: ${botNumber}`);
    } else {
      botNumber = await registerNewNumber(baseUrl);
    }
  } else {
    botNumber = await registerNewNumber(baseUrl);
  }

  // In json-rpc mode, signal-cli loads accounts at startup. After registration
  // or when the account was found only in the data directory, restart the
  // container so the daemon picks up the account for subsequent API calls.
  const restartSpinner = p.spinner();
  restartSpinner.start('Restarting signal-cli to load account...');
  try {
    await docker.stop(containerConfig.containerName);
    await docker.start(containerConfig.containerName);
    await manager.waitForHealthy(baseUrl);
    restartSpinner.stop('signal-cli restarted');
  } catch (err) {
    restartSpinner.stop('Restart failed');
    p.log.error(`Failed to restart container: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Step 4: Recipient number
  const recipientNumber = await p.text({
    message: 'Enter YOUR Signal phone number (to receive agent messages):',
    placeholder: '+15559876543',
    validate: validatePhoneNumber,
  });
  handleCancel(recipientNumber);

  // Step 5: Challenge-response identity verification
  const identityKey = await verifyRecipientIdentity(baseUrl, botNumber, recipientNumber as string);

  // Step 6: Save config
  saveUserConfig({
    signal: {
      botNumber,
      recipientNumber: recipientNumber as string,
      recipientIdentityKey: identityKey,
      container: {
        image: containerConfig.image,
        port: containerConfig.port,
      },
    },
  });

  // Summary
  p.note(
    `Bot number:       ${botNumber}\n` +
      `Your number:      ${recipientNumber as string}\n` +
      `Identity key:     ${identityKey.substring(0, 20)}...\n` +
      `Container:        ${containerConfig.containerName}\n` +
      `API port:         ${containerConfig.port}`,
    'Configuration saved',
  );

  p.outro('Setup complete. Run: ironcurtain bot');
}
