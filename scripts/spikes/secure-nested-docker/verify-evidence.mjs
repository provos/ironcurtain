#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  ENV_ALLOWLIST,
  REQUIRED_EVIDENCE_PATHS,
  SCHEMA_VERSION,
  SECRET_PATTERNS,
  assertPrivateOwner,
  assertRegularFile,
  assertRunId,
  canonicalJson,
  listEvidenceFiles,
  parseArgs,
  readJson,
  readLedger,
  sha256,
} from './evidence-lib.mjs';

const args = parseArgs(process.argv.slice(2), ['evidence-dir']);
const evidenceDir = path.resolve(args['evidence-dir']);
const manifestPath = path.join(evidenceDir, 'manifest.json');
const manifest = readJson(manifestPath);

assertRunId(manifest.runId);
if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported manifest schema');
if (!Array.isArray(manifest.files) || !Array.isArray(manifest.resourceIds)) {
  throw new Error('manifest files/resourceIds must be arrays');
}
assertPrivateOwner(evidenceDir);
assertRegularFile(manifestPath);
assertPrivateOwner(manifestPath);

const actualPaths = listEvidenceFiles(evidenceDir);
const manifestPaths = manifest.files.map((entry) => entry.path);
assertUnique(manifestPaths, 'manifest path');
assertUnique(manifest.resourceIds, 'resource ID');
if (canonicalJson(manifest) !== readFileSync(manifestPath, 'utf8')) {
  throw new Error('manifest is not canonical JSON');
}
if (JSON.stringify(actualPaths) !== JSON.stringify([...manifestPaths].sort())) {
  throw new Error('missing or unmanifested evidence files');
}
if (JSON.stringify(actualPaths) !== JSON.stringify(REQUIRED_EVIDENCE_PATHS)) {
  throw new Error('evidence schema paths do not match the Phase 0A contract');
}

for (const entry of manifest.files) {
  if (!entry || typeof entry.path !== 'string' || !/^[a-z0-9][a-z0-9./-]*$/.test(entry.path)) {
    throw new Error('invalid manifest path');
  }
  if (entry.path.includes('..') || path.isAbsolute(entry.path)) throw new Error('unsafe manifest path');
  const filename = path.join(evidenceDir, entry.path);
  assertRegularFile(filename);
  assertPrivateOwner(filename);
  const contents = readFileSync(filename);
  if (contents.length !== entry.size || sha256(contents) !== entry.sha256) {
    throw new Error(`hash or size mismatch: ${entry.path}`);
  }
  const text = contents.toString('utf8');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`secret fixture present in evidence: ${entry.path}`);
  }
}

const run = readJson(path.join(evidenceDir, 'run.json'));
if (run.runId !== manifest.runId || run.schemaVersion !== SCHEMA_VERSION) {
  throw new Error('run.json identity/schema mismatch');
}
const ledger = readLedger(evidenceDir);
if (ledger.length === 0 || ledger[0].event !== 'intent') throw new Error('ledger must begin with intent');
for (const event of ledger) assertEvidenceRunId(event, manifest.runId, 'ledger event');
const intent = ledger[0];
if (!Array.isArray(intent.argv) || intent.argv.length === 0 || !intent.specification) {
  throw new Error('intent lacks expanded argv or specification');
}
const ledgerIds = [
  ...new Set(
    ledger.filter((event) => ['created', 'recovered-discovery'].includes(event.event)).map((event) => event.resourceId),
  ),
].sort();
if (JSON.stringify(ledgerIds) !== JSON.stringify([...manifest.resourceIds].sort())) {
  throw new Error('manifest resource IDs do not match ledger');
}

for (const relative of REQUIRED_EVIDENCE_PATHS.filter((name) => name.endsWith('.json'))) {
  const value = readJson(path.join(evidenceDir, relative));
  assertEvidenceRunId(value, manifest.runId, relative);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`${relative} schema mismatch`);
}
const environment = readJson(path.join(evidenceDir, 'environment.json')).environment;
for (const [name, value] of Object.entries(environment)) {
  if (!ENV_ALLOWLIST.has(name)) throw new Error(`environment name is not allowlisted: ${name}`);
  if (typeof value !== 'string') throw new Error(`environment value is not a string: ${name}`);
}
for (const ordinal of [1, 2]) {
  const inventory = readJson(path.join(evidenceDir, `cleanup/inventory-${ordinal}.json`));
  if (inventory.ordinal !== ordinal || !Array.isArray(inventory.resources)) {
    throw new Error(`inventory ${ordinal} schema mismatch`);
  }
  if (inventory.resources.length !== 0) throw new Error(`inventory ${ordinal} is not empty`);
}

if (readdirSync(evidenceDir).includes('unexpected')) throw new Error('unexpected evidence sentinel');
console.log(`verified Phase 0A evidence: ${manifest.runId}`);

function assertEvidenceRunId(value, runId, label) {
  if (!value || value.runId !== runId) throw new Error(`${label} has wrong run ID`);
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}
