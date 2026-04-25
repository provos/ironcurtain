/**
 * `ironcurtain doctor` — on-demand diagnostics.
 *
 * Unlike pre-flight (which is a fail-fast gate), doctor:
 *   - runs every check (continue-on-failure),
 *   - includes active probes pre-flight has no reason to run,
 *   - opt-in API round-trip via --check-api.
 *
 * Process exit status: 0 if no checks return `fail`, 1 otherwise.
 * Warnings do not affect the exit code.
 */

import { parseArgs } from 'node:util';
import { checkHelp, type CommandSpec } from '../cli-help.js';
import {
  checkAnnotationDrift,
  checkAnthropicApi,
  checkAnthropicCredentials,
  checkConfigLoad,
  checkConstitutionDrift,
  checkDocker,
  checkMcpServerLiveness,
  checkNodeVersion,
  checkOAuthRefresh,
  checkPolicyArtifacts,
  checkSandbox,
  checkServerCredentials,
  type CheckResult,
} from './checks.js';
import { printCheck, printSection, printSummary } from './output.js';

const DOCTOR_HELP: CommandSpec = {
  name: 'ironcurtain doctor',
  description: 'Diagnose installation, credentials, and MCP server health',
  usage: ['ironcurtain doctor [options]'],
  options: [
    { flag: 'check-api', description: 'Also run an Anthropic API round-trip and OAuth refresh probe' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: ['ironcurtain doctor', 'ironcurtain doctor --check-api'],
};

export interface DoctorCliArgs {
  readonly checkApi: boolean;
  readonly help: boolean;
}

export function parseDoctorArgs(argv: string[]): DoctorCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      'check-api': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  return {
    checkApi: values['check-api'] === true,
    help: values.help === true,
  };
}

/**
 * Runs the doctor pipeline. Exits with 1 if any check returned `fail`.
 */
export async function runDoctorCommand(argv: string[]): Promise<void> {
  let args: DoctorCliArgs;
  try {
    args = parseDoctorArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  if (checkHelp(args, DOCTOR_HELP)) return;

  process.stdout.write('ironcurtain doctor\n');

  const collected: CheckResult[] = [];

  // Environment — sequential because failures invalidate later checks.
  printSection('Environment', { first: true });
  const nodeResult = checkNodeVersion();
  printCheck(nodeResult);
  collected.push(nodeResult);

  const sandboxResult = await checkSandbox();
  printCheck(sandboxResult);
  collected.push(sandboxResult);

  const dockerResult = await checkDocker();
  printCheck(dockerResult);
  collected.push(dockerResult);

  // Configuration — gates everything that needs the resolved config.
  printSection('Configuration');
  const configCheck = checkConfigLoad();
  printCheck(configCheck.result);
  collected.push(configCheck.result);

  if (!configCheck.config) {
    // Without a config we can't proceed past the basic environment.
    printSummary(collected);
    if (collected.some((c) => c.status === 'fail')) process.exit(1);
    return;
  }
  const config = configCheck.config;

  const policyCheck = checkPolicyArtifacts(config);
  for (const r of policyCheck.results) {
    printCheck(r);
    collected.push(r);
  }

  if (policyCheck.compiledPolicy !== undefined) {
    const constitutionResult = checkConstitutionDrift(config, policyCheck.compiledPolicy);
    printCheck(constitutionResult);
    collected.push(constitutionResult);

    const annotationResult = checkAnnotationDrift(policyCheck.toolAnnotations, config.mcpServers);
    printCheck(annotationResult);
    collected.push(annotationResult);
  }

  // Credentials.
  printSection('Credentials');
  const anthropicResult = await checkAnthropicCredentials(config);
  printCheck(anthropicResult);
  collected.push(anthropicResult);

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    const r = checkServerCredentials(serverName, serverConfig, config);
    // Only show servers that need credentials — the "no credentials required"
    // result would clutter the output with one line per server.
    if (r.message === 'no credentials required') continue;
    printCheck(r);
    collected.push(r);
  }

  // MCP servers — parallel probes.
  printSection('MCP servers');
  const livenessResults = await checkMcpServerLiveness(config);
  for (const r of livenessResults) {
    printCheck(r);
    collected.push(r);
  }

  // Optional API round-trip.
  if (args.checkApi) {
    printSection('API round-trip');
    const apiResult = await checkAnthropicApi(config);
    printCheck(apiResult);
    collected.push(apiResult);

    const refreshResult = await checkOAuthRefresh();
    printCheck(refreshResult);
    collected.push(refreshResult);
  }

  printSummary(collected);

  if (collected.some((c) => c.status === 'fail')) {
    process.exit(1);
  }
}
