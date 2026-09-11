#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGoFailureDiagnosticCodes } from './diagnostic-codes.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const architectures = ['amd64', 'arm64'];
const runtimeContractPath = join(root, '../../src/docker/build-trust-runtime-contract.ts');
const fixture = JSON.parse(readFileSync(join(root, 'testdata/synthetic-build-trust-contract.json'), 'utf8'));
const mode = process.argv[2];
if (!['--check', '--write'].includes(mode) || process.argv.length !== 3) {
  throw new Error('usage: node build.mjs --check|--write');
}
const metadata = {
  schemaVersion: 2,
  wrapper: {
    packagePaths: Object.fromEntries(
      architectures.map((arch) => [arch, `docker/build-trust-runtime/bin/linux-${arch}/ironcurtain-build-trust-runc`]),
    ),
    packageMode: '0755',
    guestMode: '0555',
  },
  realRunc: {
    path: fixture.realRunc.path,
    mode: '0755',
    nlink: 1,
    version: fixture.realRunc.version,
    requiresEffectiveReadOnly: true,
  },
  trustContract: {
    parentDirectory: {
      path: '/ironcurtain-build-trust',
      mode: '0755',
      requiresEffectiveReadOnly: true,
    },
    mode: '0444',
    nlink: 1,
    requiresEffectiveReadOnly: true,
  },
  failureDiagnostic: {
    path: '/tmp/.ironcurtain-build-trust-runc-failure-v1',
    clearCommand: '--ironcurtain-internal-clear-failure-v1',
    readCommand: '--ironcurtain-internal-read-failure-v1',
    unavailableCode: 'ICBT-DIAGNOSTIC-UNAVAILABLE-V1',
    maxCodeBytes: 128,
    allowedCodes: parseGoFailureDiagnosticCodes(readFileSync(join(root, 'main.go'), 'utf8')),
  },
};
const rendered = `/** Generated protocol/layout metadata. No executable byte pins. */\n// prettier-ignore\nexport const BUILD_TRUST_RUNTIME_CONTRACT = ${JSON.stringify(metadata, null, 2)} as const;\n`;
const temporary = mkdtempSync(join(tmpdir(), 'ironcurtain-build-trust-runtime-'));
try {
  const goVersion = execFileSync('go', ['version'], { encoding: 'utf8' }).trim();
  const outputs = [];
  for (const architecture of architectures) {
    const binary = join(temporary, `runc-${architecture}`);
    execFileSync(
      'go',
      ['build', '-buildvcs=false', '-mod=readonly', '-trimpath', '-ldflags=-s -w', '-o', binary, '.'],
      {
        cwd: root,
        env: {
          ...process.env,
          GOOS: 'linux',
          GOARCH: architecture,
          CGO_ENABLED: '0',
          GOENV: 'off',
          GOFLAGS: '',
          GOTOOLCHAIN: 'local',
        },
        stdio: 'inherit',
      },
    );
    const bytes = readFileSync(binary);
    const machine = architecture === 'amd64' ? 62 : 183;
    if (
      !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== machine
    ) {
      throw new Error(`compiler did not produce a Linux ${architecture} ELF executable`);
    }
    const relative = `bin/linux-${architecture}/ironcurtain-build-trust-runc`;
    outputs.push({ architecture, path: relative });
    if (mode === '--write') atomicWrite(join(root, relative), bytes, 0o755);
  }
  if (mode === '--write') {
    atomicWrite(runtimeContractPath, Buffer.from(rendered), 0o644);
    atomicWrite(
      join(root, 'manifest.json'),
      Buffer.from(`${JSON.stringify({ schemaVersion: 2, goVersion, targets: outputs }, null, 2)}\n`),
      0o644,
    );
  } else {
    // Compare protocol values, not compiler output. Different supported compiler
    // versions may produce different bytes without changing the runtime contract.
    const source = readFileSync(runtimeContractPath, 'utf8');
    const match = /export const BUILD_TRUST_RUNTIME_CONTRACT = ([\s\S]*?) as const;/u.exec(source);
    if (match === null || JSON.stringify(JSON.parse(match[1])) !== JSON.stringify(metadata)) {
      throw new Error('build-trust protocol metadata differs; run node build.mjs --write');
    }
  }
  process.stdout.write(
    `build-trust runtime ${mode === '--write' ? 'packaged' : 'compiled and checked'} for ${architectures.join(', ')}\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function atomicWrite(path, bytes, modeBits) {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(staging, bytes, { flag: 'wx', mode: modeBits });
    chmodSync(staging, modeBits);
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}
