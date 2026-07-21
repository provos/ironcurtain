#!/usr/bin/env node

import path from 'node:path';
import {
  SCHEMA_VERSION,
  appendLedger,
  assertOutsideWorkspace,
  assertRunId,
  deleteInspectedResource,
  ensurePrivateDirectory,
  findFakeResources,
  inventoryOwned,
  parseArgs,
  readJson,
  readLedger,
  writeJsonAtomic,
  writeManifest,
} from './evidence-lib.mjs';

const args = parseArgs(process.argv.slice(2), ['evidence-dir', 'run-id', 'state-dir', 'workspace-root']);
const evidenceDir = path.resolve(args['evidence-dir']);
const stateDir = path.resolve(args['state-dir']);
const workspaceRoot = path.resolve(args['workspace-root']);
const runId = args['run-id'];
assertRunId(runId);
assertOutsideWorkspace(evidenceDir, workspaceRoot);
assertOutsideWorkspace(stateDir, workspaceRoot);

const run = readJson(path.join(evidenceDir, 'run.json'));
if (run.runId !== runId) throw new Error('recovery run ID does not match run.json');
const identity = {
  generation: run.generation,
  requestedName: run.requestedName,
  runId,
};
const ledger = readLedger(evidenceDir);
const recordedIds = ledger.filter((event) => event.event === 'created').map((event) => event.resourceId);
const discovered = findFakeResources(
  stateDir,
  (resource) =>
    resource.runId === runId && resource.generation === run.generation && resource.requestedName === run.requestedName,
).map((resource) => resource.resourceId);
const resourceIds = [...new Set([...recordedIds, ...discovered])].sort();
const started = Date.now();

for (const resourceId of resourceIds) {
  if (!recordedIds.includes(resourceId)) {
    appendLedger(evidenceDir, {
      event: 'recovered-discovery',
      generation: run.generation,
      requestedName: run.requestedName,
      resourceId,
      runId,
      time: new Date().toISOString(),
    });
  }
  const deleted = deleteInspectedResource(stateDir, identity, resourceId);
  appendLedger(evidenceDir, {
    deleted,
    event: 'recovery-deleted',
    resourceId,
    runId,
    time: new Date().toISOString(),
  });
}

if (!path.isAbsolute(evidenceDir)) throw new Error('unreachable: evidence path must be absolute');
const cleanupDir = path.join(evidenceDir, 'cleanup');
ensurePrivateDirectory(cleanupDir);
for (const ordinal of [1, 2]) {
  writeJsonAtomic(path.join(cleanupDir, `inventory-${ordinal}.json`), {
    ordinal,
    resources: inventoryOwned(stateDir, runId),
    runId,
    schemaVersion: SCHEMA_VERSION,
  });
}
writeJsonAtomic(path.join(evidenceDir, 'mutation-result.json'), {
  durationMs: null,
  endedAt: null,
  exitCode: null,
  resourceId: null,
  runId,
  schemaVersion: SCHEMA_VERSION,
  startedAt: null,
  termination: 'uncatchable-before-runtime-return',
});
writeJsonAtomic(path.join(evidenceDir, 'cleanup-result.json'), {
  deletedResourceIds: resourceIds,
  durationMs: Date.now() - started,
  exitCode: 0,
  reason: 'recovery-command',
  runId,
  schemaVersion: SCHEMA_VERSION,
});
writeManifest(evidenceDir, runId);
