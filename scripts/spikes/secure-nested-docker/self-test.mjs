#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, readJson, sha256 } from './evidence-lib.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '../../..');
const root = mkdtempSync(path.join(os.tmpdir(), 'ic-nested-phase0a-'));
const results = [];

try {
  const benign = await runHarness('benign', 'benign');
  await verify(benign.evidenceDir);
  results.push('benign fake mutation');

  const interrupt = await startHarness('interrupt', 'hold');
  await waitForLedgerEvent(interrupt.evidenceDir, 'trap-ready');
  interrupt.child.kill('SIGINT');
  const interruptResult = await waitForChild(interrupt.child);
  if (interruptResult.code !== 130) throw new Error(`interrupt exited ${interruptResult.code}`);
  await verify(interrupt.evidenceDir);
  results.push('interrupt/trap cleanup');

  const killed = await startHarness('kill-recovery', 'kill-window');
  await waitForResource(killed.stateDir);
  killed.child.kill('SIGKILL');
  const killedResult = await waitForChild(killed.child);
  if (killedResult.signal !== 'SIGKILL') throw new Error('kill-window did not die from SIGKILL');
  await runNode('recover.mjs', commonArgs(killed));
  await verify(killed.evidenceDir);
  const recoveredLedger = readFileSync(path.join(killed.evidenceDir, 'ledger.jsonl'), 'utf8');
  if (!recoveredLedger.includes('"event":"recovered-discovery"')) {
    throw new Error('recovery did not exercise inspected identity discovery');
  }
  results.push('SIGKILL/recovery-command cleanup');

  const environment = readJson(path.join(benign.evidenceDir, 'environment.json')).environment;
  if (environment.IRONCURTAIN_0A_SAFE !== 'visible') throw new Error('safe env was not captured');
  if (environment.IRONCURTAIN_0A_REDACT !== '[REDACTED]') {
    throw new Error('allowlisted secret-like value was not redacted');
  }
  if ('ANTHROPIC_API_KEY' in environment) throw new Error('non-allowlisted secret name was captured');
  results.push('redaction fixture');

  await assertVerifierRejections(benign.evidenceDir);
  results.push('schema/tamper verification');

  console.log(`Phase 0A PASS (${results.length}/5)`);
  for (const result of results) console.log(`- ${result}`);
  console.log(`evidence root: ${root}`);
} catch (error) {
  console.error(`Phase 0A FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}

async function runHarness(label, mode) {
  const run = await startHarness(label, mode);
  const result = await waitForChild(run.child);
  if (result.code !== 0) throw new Error(`${label} harness failed: ${result.stderr}`);
  return run;
}

async function startHarness(label, mode) {
  const runId = `phase0a-${label}-0001`;
  const evidenceDir = path.join(root, label, 'evidence');
  const stateDir = path.join(root, label, 'state');
  const run = { evidenceDir, runId, stateDir };
  const child = spawn(
    process.execPath,
    [
      path.join(scriptDir, 'harness.mjs'),
      ...commonArgs(run),
      '--generation',
      '1',
      '--mode',
      mode,
      '--name',
      `ic-nested-spike-${label}-0001`,
    ],
    {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'ic-0a-secret-fixture',
        IRONCURTAIN_0A_REDACT: 'ic-0a-secret-fixture',
        IRONCURTAIN_0A_SAFE: 'visible',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return { ...run, child };
}

function commonArgs(run) {
  return [
    '--evidence-dir',
    run.evidenceDir,
    '--run-id',
    run.runId,
    '--state-dir',
    run.stateDir,
    '--workspace-root',
    workspaceRoot,
  ];
}

async function verify(evidenceDir, expectFailure = false) {
  const result = await runNode('verify-evidence.mjs', ['--evidence-dir', evidenceDir], true);
  if (expectFailure && result.code === 0) throw new Error('verifier accepted invalid evidence');
  if (!expectFailure && result.code !== 0) throw new Error(`verifier failed: ${result.stderr}`);
  return result;
}

async function assertVerifierRejections(source) {
  await mutateAndReject('missing', source, (copy) => rmSync(path.join(copy, 'cleanup-result.json')));
  await mutateAndReject('unmanifested', source, (copy) =>
    writeFileSync(path.join(copy, 'unmanifested.json'), '{}\n', { mode: 0o600 }),
  );
  await mutateAndReject('hash', source, (copy) =>
    writeFileSync(path.join(copy, 'cleanup-result.json'), '{}\n', { mode: 0o600 }),
  );
  await mutateAndReject('wrong-run-id', source, (copy) => {
    const filename = path.join(copy, 'cleanup-result.json');
    const value = readJson(filename);
    value.runId = 'phase0a-wrong-run-0001';
    writeFileSync(filename, canonicalJson(value), { mode: 0o600 });
    rehash(copy, 'cleanup-result.json');
  });
  await mutateAndReject('secret', source, (copy) => {
    const filename = path.join(copy, 'cleanup-result.json');
    const value = readJson(filename);
    value.note = ['ic-0a', 'secret-fixture'].join('-');
    writeFileSync(filename, canonicalJson(value), { mode: 0o600 });
    rehash(copy, 'cleanup-result.json');
  });
  await mutateAndReject('duplicate-path', source, (copy) => {
    const filename = path.join(copy, 'manifest.json');
    const manifest = readJson(filename);
    manifest.files.push(manifest.files[0]);
    writeFileSync(filename, canonicalJson(manifest), { mode: 0o600 });
  });
}

async function mutateAndReject(label, source, mutate) {
  const copy = path.join(root, 'tamper', label);
  cpSync(source, copy, { recursive: true });
  mutate(copy);
  await verify(copy, true);
}

function rehash(evidenceDir, relative) {
  const manifestPath = path.join(evidenceDir, 'manifest.json');
  const manifest = readJson(manifestPath);
  const entry = manifest.files.find((candidate) => candidate.path === relative);
  const contents = readFileSync(path.join(evidenceDir, relative));
  entry.sha256 = sha256(contents);
  entry.size = contents.length;
  writeFileSync(manifestPath, canonicalJson(manifest), { mode: 0o600 });
}

async function waitForLedgerEvent(evidenceDir, event) {
  await waitUntil(() => {
    try {
      return readFileSync(path.join(evidenceDir, 'ledger.jsonl'), 'utf8').includes(`"event":"${event}"`);
    } catch {
      return false;
    }
  });
}

async function waitForResource(stateDir) {
  await waitUntil(() => {
    try {
      return readdirSync(path.join(stateDir, 'resources')).some((name) => name.endsWith('.json'));
    } catch {
      return false;
    }
  });
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for fixture state');
}

async function runNode(script, args, allowFailure = false) {
  const child = spawn(process.execPath, [path.join(scriptDir, script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await waitForChild(child);
  if (!allowFailure && result.code !== 0) throw new Error(`${script} failed: ${result.stderr}`);
  return result;
}

async function waitForChild(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += chunk));
  child.stderr?.on('data', (chunk) => (stderr += chunk));
  return await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, error, signal: null, stderr, stdout }));
    child.on('close', (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}
