#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  SECRET_PATTERNS,
  assertPrivateOwner,
  assertRegularFile,
  assertRunId,
  canonicalJson,
  listEvidenceFiles,
  parseArgs,
  readJson,
  sha256,
} from './evidence-lib.mjs';

const args = parseArgs(process.argv.slice(2), ['evidence-dir']);
const evidenceDir = path.resolve(args['evidence-dir']);
const manifestPath = path.join(evidenceDir, 'manifest.json');
const manifest = readJson(manifestPath);
assertRunId(manifest.runId);
if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported schema');
if (canonicalJson(manifest) !== readFileSync(manifestPath, 'utf8')) {
  throw new Error('manifest is not canonical JSON');
}
assertPrivateOwner(evidenceDir);
assertRegularFile(manifestPath);
assertPrivateOwner(manifestPath);

const actualPaths = listEvidenceFiles(evidenceDir);
const manifestPaths = manifest.files.map((entry) => entry.path);
if (new Set(manifestPaths).size !== manifestPaths.length) throw new Error('duplicate manifest path');
if (new Set(manifest.resourceIds).size !== manifest.resourceIds.length) {
  throw new Error('duplicate resource ID');
}
if (JSON.stringify(actualPaths) !== JSON.stringify([...manifestPaths].sort())) {
  throw new Error('missing or unmanifested probe evidence');
}

for (const entry of manifest.files) {
  const filename = path.join(evidenceDir, entry.path);
  assertRegularFile(filename);
  assertPrivateOwner(filename);
  const contents = readFileSync(filename);
  if (contents.length !== entry.size || sha256(contents) !== entry.sha256) {
    throw new Error(`hash or size mismatch: ${entry.path}`);
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(contents.toString('utf8')))) {
    throw new Error(`secret fixture present: ${entry.path}`);
  }
  if (entry.path.endsWith('.json')) {
    const value = JSON.parse(contents);
    if (value.runId !== manifest.runId) throw new Error(`wrong run ID: ${entry.path}`);
  }
}

for (const required of [
  'cleanup-result.json',
  'cleanup/inventory-1.json',
  'cleanup/inventory-2.json',
  'environment.json',
  'ledger.jsonl',
  'run.json',
  'summary.json',
]) {
  if (!actualPaths.includes(required)) throw new Error(`missing required probe evidence: ${required}`);
}
for (const ordinal of [1, 2]) {
  const inventory = readJson(path.join(evidenceDir, 'cleanup', `inventory-${ordinal}.json`));
  if (inventory.containers.length || inventory.volumes.length) {
    throw new Error(`cleanup inventory ${ordinal} is not empty`);
  }
}
const cleanup = readJson(path.join(evidenceDir, 'cleanup-result.json'));
if (cleanup.status !== 'complete') throw new Error('probe cleanup did not complete');
console.log(`verified exploratory probe evidence: ${manifest.runId}`);
