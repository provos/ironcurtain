/** Linux-only node_modules identity and native-load qualification. */

import { isAbsolute, posix } from 'node:path';
import { z } from 'zod';
import { computeHash, sha256Hex, sha256HexSchema, stableStringify } from '../hash.js';
import { loadImmutableHostJson } from '../hardened-fs.js';
import type { ContainerRuntime } from './types.js';

export const LINUX_DEPENDENCY_ABI_SCHEMA_VERSION = 1;
export const LINUX_DEPENDENCY_ABI_MANIFEST = '.ironcurtain-linux-dependencies.json';
export const MAX_LINUX_DEPENDENCY_MANIFEST_BYTES = 64 * 1024;
export const REQUIRED_NATIVE_MODULES = ['isolated-vm', 'node-pty'] as const;

const versionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9][0-9A-Za-z.+_-]*$/u);

const linuxDependencyAbiSchema = z
  .object({
    schemaVersion: z.literal(LINUX_DEPENDENCY_ABI_SCHEMA_VERSION),
    platform: z.literal('linux'),
    architecture: z.enum(['amd64', 'arm64']),
    nodeVersion: versionSchema,
    nodeAbi: z.string().regex(/^\d{1,6}$/u),
    libc: z
      .object({
        family: z.enum(['glibc', 'musl']),
        version: versionSchema,
      })
      .strict(),
    packageManager: z
      .object({
        name: z.literal('npm'),
        version: versionSchema,
      })
      .strict(),
    lockfileSha256: sha256HexSchema,
    nativeModules: z.tuple([z.literal('isolated-vm'), z.literal('node-pty')]),
  })
  .strict();

const nativeProbeResultSchema = z
  .object({
    platform: z.literal('linux'),
    architecture: z.enum(['amd64', 'arm64']),
    nodeVersion: versionSchema,
    nodeAbi: z.string().regex(/^\d{1,6}$/u),
    libc: z.object({ family: z.enum(['glibc', 'musl']), version: versionSchema }).strict(),
    isolatedVm: z.literal('created'),
    nodePty: z.literal('loaded'),
  })
  .strict();

export type LinuxDependencyAbiManifest = z.infer<typeof linuxDependencyAbiSchema>;
export type LinuxDependencyNativeProbeResult = z.infer<typeof nativeProbeResultSchema>;

export interface CreateLinuxDependencyAbiManifestOptions {
  readonly architecture: 'amd64' | 'arm64';
  readonly nodeVersion: string;
  readonly nodeAbi: string;
  readonly libc: { readonly family: 'glibc' | 'musl'; readonly version: string };
  readonly npmVersion: string;
  readonly lockfileBytes: Uint8Array;
}

/** Construct the complete tuple that owns one Linux dependency store. */
export function createLinuxDependencyAbiManifest(
  options: CreateLinuxDependencyAbiManifestOptions,
): LinuxDependencyAbiManifest {
  return linuxDependencyAbiSchema.parse({
    schemaVersion: LINUX_DEPENDENCY_ABI_SCHEMA_VERSION,
    platform: 'linux',
    architecture: options.architecture,
    nodeVersion: options.nodeVersion,
    nodeAbi: options.nodeAbi,
    libc: options.libc,
    packageManager: { name: 'npm', version: options.npmVersion },
    lockfileSha256: sha256Hex(options.lockfileBytes),
    nativeModules: REQUIRED_NATIVE_MODULES,
  });
}

/** Stable, collision-resistant outer volume name; no mutable `latest` alias. */
export function linuxDependencyVolumeName(manifest: LinuxDependencyAbiManifest): string {
  const validated = linuxDependencyAbiSchema.parse(manifest);
  return `ironcurtain-linux-deps-v${LINUX_DEPENDENCY_ABI_SCHEMA_VERSION}-${computeHash(validated)}`;
}

export function serializeLinuxDependencyAbiManifest(manifest: LinuxDependencyAbiManifest): string {
  const validated = linuxDependencyAbiSchema.parse(manifest);
  return `${stableStringify(validated)}\n`;
}

/** Read the provisioned manifest without following a workspace-controlled symlink. */
export function loadLinuxDependencyAbiManifest(path: string): LinuxDependencyAbiManifest {
  return loadImmutableHostJson(path, {
    label: 'Linux dependency ABI manifest',
    schema: linuxDependencyAbiSchema,
    maxBytes: MAX_LINUX_DEPENDENCY_MANIFEST_BYTES,
  }).value;
}

/** Reject stale/macOS/wrong-ABI stores with a field-level diagnostic. */
export function assertLinuxDependencyAbiCompatible(
  actual: LinuxDependencyAbiManifest,
  expected: LinuxDependencyAbiManifest,
): void {
  const actualValidated = linuxDependencyAbiSchema.parse(actual);
  const expectedValidated = linuxDependencyAbiSchema.parse(expected);
  const fields = [
    'schemaVersion',
    'platform',
    'architecture',
    'nodeVersion',
    'nodeAbi',
    'libc',
    'packageManager',
    'lockfileSha256',
    'nativeModules',
  ] as const;
  const mismatches = fields.filter(
    (field) => stableStringify(actualValidated[field]) !== stableStringify(expectedValidated[field]),
  );
  if (mismatches.length > 0) {
    throw new Error(`Linux dependency ABI manifest mismatch: ${mismatches.join(', ')}`);
  }
}

/**
 * Command run inside the Linux agent after the dependency volume is mounted.
 * Native initialization occurs in a disposable `node` process: an ABI crash
 * becomes a nonzero docker-exec result rather than killing trusted host code.
 */
export function buildLinuxDependencyNativeProbeCommand(
  expected: LinuxDependencyAbiManifest,
  workspace = '/workspace',
): readonly string[] {
  const validated = linuxDependencyAbiSchema.parse(expected);
  if (!isAbsolute(workspace) || posix.normalize(workspace) !== workspace || workspace.includes('\0')) {
    throw new Error(`Linux dependency probe workspace must be a canonical absolute path: ${workspace}`);
  }
  const source = `
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const expected = ${JSON.stringify(validated)};
const fail = (message) => { throw new Error(message); };
const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
const header = process.report?.getReport().header ?? {};
const detectLibc = () => {
  if (typeof header.glibcVersionRuntime === 'string') {
    return { family: 'glibc', version: header.glibcVersionRuntime };
  }
  const ldd = spawnSync('ldd', ['--version'], { encoding: 'utf8', timeout: 5000 });
  const text = String(ldd.stdout ?? '') + '\\n' + String(ldd.stderr ?? '');
  const musl = /musl libc[\\s\\S]*?Version\\s+([0-9][0-9A-Za-z.+_-]*)/i.exec(text);
  if (musl) return { family: 'musl', version: musl[1] };
  fail('unable to identify Linux libc');
};
const libc = detectLibc();
if (process.platform !== expected.platform) fail('dependency platform mismatch: ' + process.platform);
if (architecture !== expected.architecture) fail('dependency architecture mismatch: ' + architecture);
if (process.versions.node !== expected.nodeVersion) fail('dependency Node version mismatch: ' + process.versions.node);
if (process.versions.modules !== expected.nodeAbi) fail('dependency Node ABI mismatch: ' + process.versions.modules);
if (libc.family !== expected.libc.family || libc.version !== expected.libc.version) {
  fail('dependency libc mismatch: ' + libc.family + '@' + libc.version);
}

const require = createRequire(${JSON.stringify(`${workspace}/package.json`)});
const ivm = require('isolated-vm');
const isolate = new ivm.Isolate({ memoryLimit: 8 });
isolate.dispose();
const pty = require('node-pty');
if (typeof pty.spawn !== 'function') fail('node-pty did not export spawn');
process.stdout.write(JSON.stringify({
  platform: process.platform,
  architecture,
  nodeVersion: process.versions.node,
  nodeAbi: process.versions.modules,
  libc,
  isolatedVm: 'created',
  nodePty: 'loaded'
}));
`;
  return ['node', '--no-warnings', '--input-type=module', '-e', source];
}

export async function probeLinuxDependencyNativeModules(
  runtime: Pick<ContainerRuntime, 'exec'>,
  containerId: string,
  expected: LinuxDependencyAbiManifest,
  workspace = '/workspace',
): Promise<LinuxDependencyNativeProbeResult> {
  const result = await runtime.exec(
    containerId,
    buildLinuxDependencyNativeProbeCommand(expected, workspace),
    15_000,
    undefined,
    workspace,
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(-4096) || result.stdout.trim().slice(-4096) || 'no diagnostic output';
    throw new Error(`Linux dependency native-module probe failed (exit ${result.exitCode}): ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim()) as unknown;
  } catch (error) {
    throw new Error('Linux dependency native-module probe returned invalid JSON', { cause: error });
  }
  const validated = nativeProbeResultSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Linux dependency native-module probe returned an invalid result: ${validated.error.issues[0]?.message ?? 'schema mismatch'}`,
    );
  }
  const manifestFromProbe: LinuxDependencyAbiManifest = {
    ...expected,
    platform: validated.data.platform,
    architecture: validated.data.architecture,
    nodeVersion: validated.data.nodeVersion,
    nodeAbi: validated.data.nodeAbi,
    libc: validated.data.libc,
  };
  assertLinuxDependencyAbiCompatible(manifestFromProbe, expected);
  return validated.data;
}
