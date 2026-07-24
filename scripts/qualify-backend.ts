#!/usr/bin/env node
/**
 * Backend qualification entrypoint (release gate, not a session control).
 *
 * Drives one frozen per-variant qualification contract end to end: it runs every
 * executable command through the pinned local Vitest entrypoint, self-adjudicates
 * each run against the contract's frozen test-file set and exact test count, then
 * requires the whole set to be complete (exactly one verified run per executable
 * disposition, no `compatibility-blocker`, no run for a not-applicable gate).
 *
 * This is the "declare a backend supported" gate. It is deliberately NOT wired
 * into session startup: qualification says a *build* was measured against a
 * pre-registered bar, which is a release fact. Ordinary sessions bind operational
 * inputs (catalog, profile, egress manifests, watchdog policy, relay, toolchain)
 * and run fast live preflight checks instead.
 *
 * Evidence: each command writes `<id>.vitest.json` (the stock reporter output,
 * which carries the full per-test enumeration) and a hash-bound `<id>.run.json`
 * into the evidence directory. The runner refuses to overwrite either, so a
 * re-run needs a fresh directory.
 *
 * Usage:
 *   tsx scripts/qualify-backend.ts --contract <path> [--evidence-dir <path>]
 *                                  [--repository-root <path>] [--timeout-ms <n>]
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import {
  loadQualificationContract,
  verifyQualificationRunSet,
  type VerifiedQualificationRun,
} from '../src/docker/qualification-contract.js';
import { runVitestQualificationCommand } from '../src/docker-workload/qualification-runner.js';

const { values } = parseArgs({
  options: {
    contract: { type: 'string' },
    'evidence-dir': { type: 'string' },
    'repository-root': { type: 'string' },
    'timeout-ms': { type: 'string' },
  },
});

if (values.contract === undefined) {
  process.stderr.write('usage: qualify-backend --contract <frozen-contract.json> [--evidence-dir <dir>]\n');
  process.exit(2);
}

const contractPath = resolve(values.contract);
const repositoryRoot = resolve(values['repository-root'] ?? process.cwd());
const evidenceDirectory = resolve(values['evidence-dir'] ?? `qualification-evidence/${Date.now()}`);
const timeoutMs = Number(values['timeout-ms'] ?? 30 * 60_000);

const contract = loadQualificationContract(contractPath);
const { contractId, platform, architecture, variant, commands } = contract.value;
const executable = commands.filter(
  (command) => command.disposition === 'required-pass' || command.disposition === 'backend-adapted-pass',
);

process.stdout.write(
  `qualifying ${contractId} (${platform}/${architecture}, variant ${variant})\n` +
    `  contract sha256 : ${contract.sha256}\n` +
    `  evidence        : ${evidenceDirectory}\n` +
    `  executable gates: ${executable.length} of ${commands.length} commands\n\n`,
);

// The runner requires an owner-only evidence directory (run records and reports are
// qualification evidence); chmod explicitly so a permissive umask cannot relax it.
mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
chmodSync(evidenceDirectory, 0o700);

const verified: VerifiedQualificationRun[] = [];
for (const command of executable) {
  process.stdout.write(`  [${command.disposition}] ${command.id} ... `);
  const result = await runVitestQualificationCommand({
    contractPath,
    commandId: command.id,
    repositoryRoot,
    evidenceDirectory,
    timeoutMs,
  });
  verified.push(result.verified);
  process.stdout.write(`${result.verified.testCount} tests passed\n`);
}

// Set-level adjudication: completeness, blockers, and no stray runs for N/A gates.
verifyQualificationRunSet(contract.value, verified);

const total = verified.reduce((sum, run) => sum + run.testCount, 0);
process.stdout.write(`\nQUALIFIED ${contractId}: ${verified.length} commands, ${total} tests, zero skips.\n`);
