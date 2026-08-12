import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
export const ENV_ALLOWLIST = new Set(['LANG', 'LC_ALL', 'PATH', 'SHELL', 'TERM', 'TMPDIR']);
export const SECRET_PATTERNS = [/sk-ant-[a-z0-9_-]+/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/];
export function parseArgs(argv, required) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(`invalid argument: ${arg}`);
    }
    values[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  for (const name of required) {
    if (!values[name]) throw new Error(`missing --${name}`);
  }
  return values;
}

export function assertRunId(runId) {
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(runId)) {
    throw new Error(`invalid run ID: ${runId}`);
  }
}

export function assertOutsideWorkspace(target, workspaceRoot) {
  if (!path.isAbsolute(target) || !path.isAbsolute(workspaceRoot)) {
    throw new Error('evidence, state, and workspace paths must be absolute');
  }
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(target));
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`${target} must be outside workspace ${workspaceRoot}`);
  }
}

export function ensurePrivateDirectory(directory, mustBeEmpty = false) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (mustBeEmpty && readdirSync(directory).length !== 0) {
    throw new Error(`directory is not empty: ${directory}`);
  }
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortObject(item)]),
    );
  }
  return value;
}

export function writeJsonAtomic(filename, value) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, canonicalJson(value), { mode: 0o600, flag: 'wx' });
  const fd = openSync(temporary, 'r');
  fsyncSync(fd);
  closeSync(fd);
  renameSync(temporary, filename);
  fsyncDirectory(path.dirname(filename));
}

export function appendLedger(evidenceDir, event) {
  const filename = path.join(evidenceDir, 'ledger.jsonl');
  const fd = openSync(filename, 'a', 0o600);
  try {
    appendFileSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(directory) {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'));
}

export function readLedger(evidenceDir) {
  const filename = path.join(evidenceDir, 'ledger.jsonl');
  return readFileSync(filename, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid ledger line ${index + 1}: ${error.message}`);
      }
    });
}

export function captureEnvironment(environment) {
  const captured = {};
  for (const name of [...ENV_ALLOWLIST].sort()) {
    const value = environment[name];
    if (value === undefined) continue;
    captured[name] = isSecret(value) ? '[REDACTED]' : value;
  }
  return captured;
}

export function isSecret(value) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export function listEvidenceFiles(evidenceDir) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(evidenceDir, absolute).split(path.sep).join('/');
      if (relative === 'manifest.json') continue;
      if (entry.isSymbolicLink()) throw new Error(`evidence symlink is forbidden: ${relative}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`unsupported evidence entry: ${relative}`);
    }
  }
  visit(evidenceDir);
  return files.sort();
}

export function writeManifest(evidenceDir, runId) {
  const ledger = readLedger(evidenceDir);
  const resourceIds = [
    ...new Set(
      ledger
        .filter((event) => ['created', 'recovered-discovery'].includes(event.event))
        .map((event) => event.resourceId),
    ),
  ].sort();
  const files = listEvidenceFiles(evidenceDir).map((relative) => {
    const contents = readFileSync(path.join(evidenceDir, relative));
    return { path: relative, sha256: sha256(contents), size: contents.length };
  });
  writeJsonAtomic(path.join(evidenceDir, 'manifest.json'), {
    files,
    resourceIds,
    runId,
    schemaVersion: SCHEMA_VERSION,
  });
}

export function assertPrivateOwner(filename) {
  const stat = statSync(filename);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`evidence is not owned by current host user: ${filename}`);
  }
  if ((stat.mode & 0o077) !== 0) throw new Error(`evidence is not private: ${filename}`);
}

export function assertRegularFile(filename) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`not a regular file: ${filename}`);
}
