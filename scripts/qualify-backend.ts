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

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import {
  loadQualificationContract,
  verifyQualificationRunSet,
  type VerifiedQualificationRun,
} from '../src/docker/qualification-contract.js';
import { verifyQualificationArtifactBindings } from '../src/docker-workload/qualification-artifacts.js';
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
    `  executable gates: ${executable.length} of ${commands.length} commands\n`,
);

// Fail fast: recompute every disk-derivable binding before burning test time, so a drifted TCB
// artifact (catalog, profile, watchdog policy, build-egress manifest) aborts
// the gate instead of being blessed by a run that merely echoes the contract back at itself. The
// commit warning goes first because "the tree moved past the freeze commit" usually explains drift.
warnOnSourceCommitDrift(contract.value.bindings.sourceCommit, repositoryRoot);
verifyQualificationArtifactBindings(contract.value, repositoryRoot);
process.stdout.write(`  artifact bindings verified against ${repositoryRoot}\n\n`);

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

/**
 * Report, but never enforce, source-tree drift. The bound artifacts are verified byte-for-byte
 * above; the commit is git state, and this tool has to stay runnable on a tree under active
 * development. A drifted HEAD means the run measured a different tree than the one frozen.
 */
function warnOnSourceCommitDrift(frozenCommit: string, root: string): void {
  const head = currentHeadCommit(root);
  if (head === undefined) {
    process.stderr.write('  WARNING: git is unavailable; cannot check the frozen source commit.\n');
    return;
  }
  if (head === frozenCommit) return;
  process.stderr.write(
    `  WARNING: working tree HEAD ${head} differs from the contract's frozen source commit ${frozenCommit}.\n` +
      '           This run measures a different tree and is NOT a qualifying run for the frozen contract.\n',
  );
}

function currentHeadCommit(root: string): string | undefined {
  try {
    // execFileSync with an argument array: no shell, no string concatenation.
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}
