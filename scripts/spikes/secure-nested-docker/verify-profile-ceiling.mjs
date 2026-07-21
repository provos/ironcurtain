#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '../../..');
const ceilingPath = path.join(workspaceRoot, 'config/docker-workload/profile-ceiling.json');
const ceiling = readJson(ceilingPath);
const seccomp = ceiling.categories?.seccomp;

assert(ceiling.schemaVersion === 1, 'unsupported profile-ceiling schema');
assert(ceiling.maximumArtifactsPerCategory === 1, 'profile ceiling must permit exactly one artifact per category');
assert(seccomp?.artifact?.path, 'seccomp artifact path is missing');
assertHash(seccomp.artifact.sha256, 'seccomp artifact sha256');
assertHash(seccomp.source?.sha256, 'source raw sha256');
assertHash(seccomp.source?.canonicalSha256, 'source canonical sha256');

const artifactPath = path.resolve(workspaceRoot, seccomp.artifact.path);
assert(
  artifactPath.startsWith(`${path.resolve(workspaceRoot, 'config/docker-workload/seccomp')}${path.sep}`),
  'seccomp artifact escapes its checked-in directory',
);
const artifactBytes = readFileSync(artifactPath);
assert(sha256(artifactBytes) === seccomp.artifact.sha256, 'seccomp artifact hash does not match profile ceiling');

const artifact = JSON.parse(artifactBytes);
assert(artifact.defaultAction === 'SCMP_ACT_ERRNO', 'seccomp artifact is not deny-by-default');
assert(Array.isArray(artifact.syscalls), 'seccomp artifact syscall list is missing');

const taggedEntries = [];
const baseArtifact = structuredClone(artifact);
baseArtifact.syscalls = baseArtifact.syscalls.filter((entry) => {
  if (entry.comment?.startsWith('IronCurtain P2:')) {
    taggedEntries.push(entry);
    return false;
  }
  return true;
});
assert(
  sha256(JSON.stringify(baseArtifact)) === seccomp.source.canonicalSha256,
  'seccomp artifact has a change outside the tagged IronCurtain additions',
);

const declared = new Map();
for (const addition of seccomp.additions ?? []) {
  assert(typeof addition.syscall === 'string' && addition.syscall.length > 0, 'addition syscall is missing');
  assert(!declared.has(addition.syscall), `duplicate declared syscall: ${addition.syscall}`);
  assert(addition.arguments === 'all', `addition must explicitly declare arguments=all: ${addition.syscall}`);
  const eligible = seccomp.eligibleGroups?.[addition.group];
  assert(
    Array.isArray(eligible) && eligible.includes(addition.syscall),
    `addition is outside its eligible group: ${addition.syscall}`,
  );
  assert(!(seccomp.forbidden ?? []).includes(addition.syscall), `forbidden syscall was added: ${addition.syscall}`);
  assertEvidence(addition.denialEvidence, addition.syscall);
  assert(
    addition.reviewerDisposition === 'Eligible for the cumulative P2 probe only; this is not qualification approval.',
    `addition lacks the probe-only reviewer disposition: ${addition.syscall}`,
  );
  declared.set(addition.syscall, addition);
}

const emitted = new Set();
for (const entry of taggedEntries) {
  assert(entry.action === 'SCMP_ACT_ALLOW', 'tagged entry is not an allow rule');
  assert(Array.isArray(entry.names) && entry.names.length === 1, 'each tagged entry must name exactly one syscall');
  assert(
    !entry.args && !entry.includes && !entry.excludes && !entry.errnoRet,
    'tagged entry contains undeclared conditions',
  );
  const syscall = entry.names[0];
  assert(declared.has(syscall), `artifact contains undeclared tagged syscall: ${syscall}`);
  assert(!emitted.has(syscall), `artifact contains duplicate tagged syscall: ${syscall}`);
  emitted.add(syscall);
}

assert(emitted.size === declared.size, 'artifact and declared addition counts differ');
for (const syscall of declared.keys())
  assert(emitted.has(syscall), `declared syscall is absent from artifact: ${syscall}`);

process.stdout.write(`verified P2 subset: ${[...emitted].sort().join(', ')}; artifact ${seccomp.artifact.sha256}\n`);

function assertEvidence(evidence, syscall) {
  assert(evidence && typeof evidence === 'object', `denial evidence is missing: ${syscall}`);
  assert(/^[a-z0-9][a-z0-9-]{0,127}$/.test(evidence.runId ?? ''), `invalid denial run ID: ${syscall}`);
  assert(
    /^commands\/[a-zA-Z0-9._-]+\.json$/.test(evidence.commandPath ?? ''),
    `invalid denial command path: ${syscall}`,
  );
  assertHash(evidence.rootManifestSha256, `denial manifest hash: ${syscall}`);
  assertHash(evidence.commandSha256, `denial command hash: ${syscall}`);
  assert(
    typeof evidence.observation === 'string' && evidence.observation.length > 0,
    `denial observation is missing: ${syscall}`,
  );
}

function assertHash(value, label) {
  assert(/^[a-f0-9]{64}$/.test(value ?? ''), `${label} is not a SHA-256 digest`);
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
