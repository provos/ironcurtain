#!/usr/bin/env node

import path from 'node:path';
import {
  SCHEMA_VERSION,
  appendLedger,
  assertOutsideWorkspace,
  assertRunId,
  captureEnvironment,
  createFakeResource,
  deleteInspectedResource,
  ensurePrivateDirectory,
  inventoryOwned,
  parseArgs,
  writeJsonAtomic,
  writeManifest,
} from './evidence-lib.mjs';

const args = parseArgs(process.argv.slice(2), [
  'evidence-dir',
  'generation',
  'mode',
  'name',
  'run-id',
  'state-dir',
  'workspace-root',
]);
const evidenceDir = path.resolve(args['evidence-dir']);
const stateDir = path.resolve(args['state-dir']);
const workspaceRoot = path.resolve(args['workspace-root']);
const runId = args['run-id'];
const requestedName = args.name;
const generation = Number(args.generation);
const mode = args.mode;

assertRunId(runId);
assertOutsideWorkspace(evidenceDir, workspaceRoot);
assertOutsideWorkspace(stateDir, workspaceRoot);
if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('generation must be positive');
if (!['benign', 'hold', 'kill-window'].includes(mode)) throw new Error(`invalid mode: ${mode}`);
if (!/^ic-nested-spike-[a-z0-9-]+$/.test(requestedName)) throw new Error('invalid requested name');

ensurePrivateDirectory(evidenceDir, true);
ensurePrivateDirectory(stateDir);
writeJsonAtomic(path.join(evidenceDir, 'run.json'), {
  generation,
  requestedName,
  runId,
  schemaVersion: SCHEMA_VERSION,
  specification: {
    kind: 'phase-0a-fake-file-resource',
    ownership: 'run-id-generation-name',
  },
});
writeJsonAtomic(path.join(evidenceDir, 'environment.json'), {
  environment: captureEnvironment(process.env),
  runId,
  schemaVersion: SCHEMA_VERSION,
});

const expandedArgv = [
  'fake-runtime',
  'create',
  '--state-dir',
  stateDir,
  '--run-id',
  runId,
  '--generation',
  String(generation),
  '--name',
  requestedName,
];
const startedAt = new Date().toISOString();
appendLedger(evidenceDir, {
  argv: expandedArgv,
  event: 'intent',
  generation,
  requestedName,
  runId,
  specification: {
    kind: 'phase-0a-fake-file-resource',
    ownership: 'run-id-generation-name',
  },
  time: startedAt,
});

const identity = { generation, requestedName, runId };
const resourceId = createFakeResource(stateDir, identity);

if (mode === 'kill-window') {
  // Simulates SIGKILL after the runtime mutates but before it returns its ID.
  await holdForever();
}

// This durable ID record is deliberately the first operation after create returns.
appendLedger(evidenceDir, {
  event: 'created',
  generation,
  requestedName,
  resourceId,
  runId,
  time: new Date().toISOString(),
});
writeJsonAtomic(path.join(evidenceDir, 'mutation-result.json'), {
  durationMs: Date.now() - Date.parse(startedAt),
  endedAt: new Date().toISOString(),
  exitCode: 0,
  resourceId,
  runId,
  schemaVersion: SCHEMA_VERSION,
  startedAt,
});

let cleaning = false;
async function cleanup(reason, exitCode) {
  if (cleaning) return;
  cleaning = true;
  const cleanupStarted = Date.now();
  appendLedger(evidenceDir, {
    event: 'cleanup-started',
    reason,
    resourceId,
    runId,
    time: new Date().toISOString(),
  });
  const deleted = deleteInspectedResource(stateDir, identity, resourceId);
  appendLedger(evidenceDir, {
    deleted,
    event: 'deleted',
    resourceId,
    runId,
    time: new Date().toISOString(),
  });
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
  writeJsonAtomic(path.join(evidenceDir, 'cleanup-result.json'), {
    deletedResourceIds: deleted ? [resourceId] : [],
    durationMs: Date.now() - cleanupStarted,
    exitCode,
    reason,
    runId,
    schemaVersion: SCHEMA_VERSION,
  });
  writeManifest(evidenceDir, runId);
  process.exit(exitCode);
}

process.on('SIGINT', () => void cleanup('SIGINT', 130));
process.on('SIGTERM', () => void cleanup('SIGTERM', 143));

if (mode === 'benign') {
  await cleanup('normal', 0);
} else {
  appendLedger(evidenceDir, {
    event: 'trap-ready',
    resourceId,
    runId,
    time: new Date().toISOString(),
  });
  await holdForever();
}

async function holdForever() {
  await new Promise(() => setInterval(() => {}, 1_000));
}
