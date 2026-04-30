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
  checkAgentApiRoundtrip,
  checkAnnotationDrift,
  checkConfigLoad,
  checkConstitutionDrift,
  checkDocker,
  checkMcpServerLiveness,
  checkNodeVersion,
  checkPolicyArtifacts,
  checkPreferredMode,
  checkSandbox,
  checkServerCredentials,
  collectDeclaredEnvVars,
  type CheckResult,
} from './checks.js';
import { checkAnthropicCredentials, checkOAuthRefresh } from './oauth-checks.js';
import { probeServer } from './mcp-liveness.js';
import { printCheck, printSection, printSummary } from './output.js';

/**
 * Injectable dependencies for runDoctorCommand. Tests pass a probe stub
 * to avoid spawning real MCP servers; production calls receive the
 * default probe automatically.
 */
export interface DoctorDeps {
  readonly probeMcpServer?: typeof probeServer;
}

const DOCTOR_HELP: CommandSpec = {
  name: 'ironcurtain doctor',
  description: 'Diagnose installation, credentials, and MCP server health',
  usage: ['ironcurtain doctor [options]'],
  options: [
    { flag: 'check-api', description: 'Also run an agent-model API round-trip and OAuth refresh probe' },
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
export async function runDoctorCommand(argv: string[], deps: DoctorDeps = {}): Promise<void> {
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

  // Environment — sandbox and docker probes are independent, kick off in
  // parallel and await in declaration order so output stays deterministic.
  printSection('Environment', { first: true });
  const nodeResult = checkNodeVersion();
  printCheck(nodeResult);
  collected.push(nodeResult);

  const sandboxPromise = checkSandbox();
  const dockerPromise = checkDocker();

  const sandboxResult = await sandboxPromise;
  printCheck(sandboxResult);
  collected.push(sandboxResult);

  const dockerResult = await dockerPromise;
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
    exitWithStatus(collected);
  }
  const config = configCheck.config;

  // Reuse the dockerResult from the Environment section so Docker is
  // probed at most once per doctor run. checkPreferredMode upgrades the
  // earlier warn to a fail when preferredMode is "docker", because in that
  // configuration Docker unavailability means sessions refuse to start.
  const preferredModeResult = checkPreferredMode(config, dockerResult);
  printCheck(preferredModeResult);
  collected.push(preferredModeResult);

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
    // Skip servers with no declared credential env vars — they'd otherwise
    // produce one "no credentials required" line per server, drowning out
    // the servers that actually need attention.
    if (collectDeclaredEnvVars(serverConfig).length === 0) continue;
    const r = checkServerCredentials(serverName, serverConfig, config);
    printCheck(r);
    collected.push(r);
  }

  // MCP servers — parallel probes.
  printSection('MCP servers');
  const livenessResults = await checkMcpServerLiveness(config, { probe: deps.probeMcpServer });
  for (const r of livenessResults) {
    printCheck(r);
    collected.push(r);
  }

  // Optional API round-trip.
  if (args.checkApi) {
    printSection('API round-trip');
    const apiResult = await checkAgentApiRoundtrip(config);
    printCheck(apiResult);
    collected.push(apiResult);

    const refreshResult = await checkOAuthRefresh(config);
    printCheck(refreshResult);
    collected.push(refreshResult);
  }

  printSummary(collected);
  exitWithStatus(collected);
}

/**
 * Exits the process with status 1 on any check failure, 0 otherwise.
 * Always exits explicitly because MCP server subprocesses spawned by the
 * liveness probes can keep the Node event loop alive past the last printed
 * line, even after `client.close()` (the MCP SDK doesn't aggressively
 * SIGKILL the child).
 */
function exitWithStatus(collected: CheckResult[]): never {
  process.exit(collected.some((c) => c.status === 'fail') ? 1 : 0);
}
