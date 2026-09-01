#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGoFailureDiagnosticCodes, requireExactFailureDiagnosticCodes } from './diagnostic-codes.mjs';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const outputPath = join(packageRoot, 'bin', 'linux-arm64', 'ironcurtain-build-trust-runc');
const manifestPath = join(packageRoot, 'manifest.json');
const runtimeContractPath = join(packageRoot, '..', '..', 'src', 'docker', 'build-trust-runtime-contract.ts');
const liveSmokeProbePath = join(
  packageRoot,
  '..',
  '..',
  'src',
  'workflow',
  'workflows',
  'nested-docker-live-smoke',
  'scripts',
  'nested_docker_probe.py',
);
const mainGoPath = join(packageRoot, 'main.go');
const contractFixturePath = join(packageRoot, 'testdata', 'synthetic-build-trust-contract.json');
const clientToolchainManifestPath = join(
  packageRoot,
  '..',
  '..',
  'config',
  'docker-workload',
  'client-toolchain.arm64.json',
);
const evidenceRoot = join(packageRoot, '..', '..', 'docs', 'designs', 'evidence');
const envelopeEvidence = [
  {
    networkMode: 'none',
    path: 'ca-injection-buildkit-oci-envelope.fixture.json',
  },
  {
    networkMode: 'host',
    path: 'ca-injection-buildkit-oci-envelope-host.fixture.json',
  },
];
const envelopeComparisonPath = 'ca-injection-buildkit-oci-envelope-comparison.json';
const sourceFiles = [
  'go.mod',
  'diagnostic-codes.mjs',
  ...readdirSync(packageRoot)
    .filter((path) => path.endsWith('.go'))
    .sort(),
];
const canonicalFailureDiagnosticCodes = parseGoFailureDiagnosticCodes(readFileSync(mainGoPath, 'utf8'));
const buildArguments = ['build', '-buildvcs=false', '-mod=readonly', '-trimpath', '-ldflags=-buildid= -s -w'];
const selectedImageRealRunc = JSON.parse(readFileSync(clientToolchainManifestPath, 'utf8')).realRunc;
if (
  selectedImageRealRunc.uid !== 0 ||
  selectedImageRealRunc.gid !== 0 ||
  selectedImageRealRunc.mode !== '0755' ||
  selectedImageRealRunc.nlink !== 1
) {
  throw new Error('client toolchain real runc does not have the qualified root-owned outer identity');
}
const realRunc = {
  path: selectedImageRealRunc.path,
  sha256: selectedImageRealRunc.sha256,
  size: selectedImageRealRunc.size,
  ownerPairs: [
    { uid: selectedImageRealRunc.uid, gid: selectedImageRealRunc.gid },
    { uid: 65534, gid: 65534 },
  ],
  nlink: selectedImageRealRunc.nlink,
  mode: selectedImageRealRunc.mode,
  version: selectedImageRealRunc.version,
};
const trustContract = {
  parentDirectory: {
    path: '/opt/ironcurtain-build-trust',
    uid: 0,
    gid: 0,
    mode: '0755',
    ownerPairs: [
      { uid: 0, gid: 0 },
      { uid: 65534, gid: 65534 },
    ],
  },
  mode: '0444',
  nlink: 1,
  requiresEffectiveReadOnly: true,
};
const failureDiagnostic = {
  path: '/tmp/.ironcurtain-build-trust-runc-failure-v1',
  clearCommand: '--ironcurtain-internal-clear-failure-v1',
  readCommand: '--ironcurtain-internal-read-failure-v1',
  unavailableCode: 'ICBT-DIAGNOSTIC-UNAVAILABLE-V1',
  maxCodeBytes: 128,
  allowedCodes: canonicalFailureDiagnosticCodes,
};
const caGenerationPattern = /^gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

if (!['--check', '--write'].includes(process.argv[2]) || process.argv.length !== 3) {
  process.stderr.write('usage: node build.mjs --check|--write\n');
  process.exit(2);
}

const mode = process.argv[2];
if (mode === '--check') {
  const generatedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  requireExactFailureDiagnosticCodes(
    canonicalFailureDiagnosticCodes,
    generatedManifest?.stagingContract?.failureDiagnostic?.allowedCodes,
  );
}
const temporaryRoot = mkdtempSync(join(tmpdir(), 'ironcurtain-build-trust-runtime-'));
try {
  const temporaryBinary = join(temporaryRoot, 'ironcurtain-build-trust-runc');
  const goVersionOutput = execFileSync('go', ['version'], { encoding: 'utf8' }).trim();
  const goVersion = /\b(go\d+\.\d+(?:\.\d+)?)\b/.exec(goVersionOutput)?.[1];
  if (goVersion === undefined) {
    throw new Error(`cannot parse Go version from: ${goVersionOutput}`);
  }
  execFileSync('go', [...buildArguments, '-o', temporaryBinary, '.'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      CGO_ENABLED: '0',
      GOARCH: 'arm64',
      GOCACHE: join(temporaryRoot, 'go-cache'),
      GOENV: 'off',
      GOFLAGS: '',
      GOOS: 'linux',
      GOTOOLCHAIN: 'local',
    },
    stdio: 'inherit',
  });
  const binary = readFileSync(temporaryBinary);
  const runtimeContractObject = {
    schemaVersion: 1,
    wrapper: {
      packagePath: 'docker/build-trust-runtime/bin/linux-arm64/ironcurtain-build-trust-runc',
      sha256: sha256(binary),
      size: binary.length,
      packageMode: '0755',
      guestMode: '0555',
    },
    realRunc,
    trustContract,
    failureDiagnostic,
  };
  const runtimeContract = renderRuntimeContract(runtimeContractObject);
  const liveSmokeProbe = renderLiveSmokeProbe(
    readFileSync(liveSmokeProbePath, 'utf8'),
    runtimeContractObject.wrapper.sha256,
  );
  const contractFixture = JSON.parse(readFileSync(contractFixturePath, 'utf8'));
  if (!caGenerationPattern.test(contractFixture.caGeneration)) {
    throw new Error('synthetic trust contract has an invalid CA generation');
  }
  const manifestObject = {
    schemaVersion: 1,
    target: { os: 'linux', architecture: 'arm64', cgoEnabled: false },
    realRuncPath: realRunc.path,
    goVersion,
    buildArguments,
    sourceFiles,
    sourceSha256: hashSources(sourceFiles),
    builderSha256: sha256(readFileSync(join(packageRoot, 'build.mjs'))),
    binary: {
      path: 'bin/linux-arm64/ironcurtain-build-trust-runc',
      sha256: sha256(binary),
      size: binary.length,
      mode: '0755',
    },
    stagingContract: {
      productionReachable: true,
      runtimeContract: {
        packagePath: 'src/docker/build-trust-runtime-contract.ts',
        sha256: sha256(Buffer.from(runtimeContract)),
      },
      wrapper: {
        packagePath: 'bin/linux-arm64/ironcurtain-build-trust-runc',
        packageMode: '0755',
        requiredGuestMode: '0555',
        qualifiedOCIEnvelopes: {
          structuralSummariesOnly: true,
          entries: envelopeEvidence.map(({ networkMode, path }) => ({
            networkMode,
            packagePath: `docs/designs/evidence/${path}`,
            sha256: sha256(readFileSync(join(evidenceRoot, path))),
          })),
          comparison: {
            packagePath: `docs/designs/evidence/${envelopeComparisonPath}`,
            sha256: sha256(readFileSync(join(evidenceRoot, envelopeComparisonPath))),
          },
        },
      },
      trustContract: {
        path: '/opt/ironcurtain-build-trust/build-trust-contract.json',
        parentDirectory: trustContract.parentDirectory,
        requiredMode: trustContract.mode,
        requiredLinkCount: trustContract.nlink,
        requiresEffectiveReadOnly: trustContract.requiresEffectiveReadOnly,
        schemaFixtureSha256: sha256(readFileSync(contractFixturePath)),
        schemaVersion: contractFixture.schemaVersion,
        rootFields: Object.keys(contractFixture).sort(),
        caGenerationFormat: 'gen-uuid-v4-lowercase',
        commonIntegrityFields: ['sha256', 'size', 'mode'],
        realRunc: {
          path: contractFixture.realRunc.path,
          version: contractFixture.realRunc.version,
          ownerPairs: contractFixture.realRunc.ownerPairs,
          requiredLinkCount: contractFixture.realRunc.nlink,
        },
        publicSources: contractFixture.publicSources.map(({ path, destination, mode }) => ({
          path,
          destination,
          requiredMode: mode,
        })),
      },
      failureDiagnostic,
    },
  };
  const manifest = `${JSON.stringify(manifestObject, null, 2)}\n`;

  if (mode === '--write') {
    atomicWrite(outputPath, binary, 0o755);
    atomicWrite(runtimeContractPath, Buffer.from(runtimeContract), 0o644);
    atomicWrite(liveSmokeProbePath, Buffer.from(liveSmokeProbe), 0o644);
    atomicWrite(manifestPath, Buffer.from(manifest), 0o644);
    process.stdout.write(
      `wrote ${outputPath}\nwrote ${runtimeContractPath}\nwrote ${liveSmokeProbePath}\nwrote ${manifestPath}\n`,
    );
  } else {
    requireExact(outputPath, binary, 0o755);
    requireExact(runtimeContractPath, Buffer.from(runtimeContract), 0o644);
    requireExact(liveSmokeProbePath, Buffer.from(liveSmokeProbe), 0o644);
    requireExact(manifestPath, Buffer.from(manifest), 0o644);
    process.stdout.write('build-trust runtime binary and manifest are fresh\n');
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function hashSources(files) {
  const hash = createHash('sha256');
  for (const path of files) {
    const contents = readFileSync(join(packageRoot, path));
    hash.update(path);
    hash.update('\0');
    hash.update(String(contents.length));
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function renderRuntimeContract(contract) {
  const stringLiteral = (value) => {
    if (!/^[A-Za-z0-9_./:-]+$/u.test(value)) throw new Error(`unsafe generated runtime-contract string: ${value}`);
    return `'${value}'`;
  };
  return `/** Generated by docker/build-trust-runtime/build.mjs. Do not edit. */
export const BUILD_TRUST_RUNTIME_CONTRACT = {
  schemaVersion: ${contract.schemaVersion},
  wrapper: {
    packagePath: ${stringLiteral(contract.wrapper.packagePath)},
    sha256: ${stringLiteral(contract.wrapper.sha256)},
    size: ${contract.wrapper.size},
    packageMode: ${stringLiteral(contract.wrapper.packageMode)},
    guestMode: ${stringLiteral(contract.wrapper.guestMode)},
  },
  realRunc: {
    path: ${stringLiteral(contract.realRunc.path)},
    sha256: ${stringLiteral(contract.realRunc.sha256)},
    size: ${contract.realRunc.size},
    ownerPairs: [
      { uid: ${contract.realRunc.ownerPairs[0].uid}, gid: ${contract.realRunc.ownerPairs[0].gid} },
      { uid: ${contract.realRunc.ownerPairs[1].uid}, gid: ${contract.realRunc.ownerPairs[1].gid} },
    ],
    nlink: ${contract.realRunc.nlink},
    mode: ${stringLiteral(contract.realRunc.mode)},
    version: ${stringLiteral(contract.realRunc.version)},
  },
  trustContract: {
    parentDirectory: {
      path: ${stringLiteral(contract.trustContract.parentDirectory.path)},
      uid: ${contract.trustContract.parentDirectory.uid},
      gid: ${contract.trustContract.parentDirectory.gid},
      mode: ${stringLiteral(contract.trustContract.parentDirectory.mode)},
      ownerPairs: [
        { uid: ${contract.trustContract.parentDirectory.ownerPairs[0].uid}, gid: ${contract.trustContract.parentDirectory.ownerPairs[0].gid} },
        { uid: ${contract.trustContract.parentDirectory.ownerPairs[1].uid}, gid: ${contract.trustContract.parentDirectory.ownerPairs[1].gid} },
      ],
    },
    mode: ${stringLiteral(contract.trustContract.mode)},
    nlink: ${contract.trustContract.nlink},
    requiresEffectiveReadOnly: ${contract.trustContract.requiresEffectiveReadOnly},
  },
  failureDiagnostic: {
    path: ${stringLiteral(contract.failureDiagnostic.path)},
    clearCommand: ${stringLiteral(contract.failureDiagnostic.clearCommand)},
    readCommand: ${stringLiteral(contract.failureDiagnostic.readCommand)},
    unavailableCode: ${stringLiteral(contract.failureDiagnostic.unavailableCode)},
    maxCodeBytes: ${contract.failureDiagnostic.maxCodeBytes},
    allowedCodes: [
${contract.failureDiagnostic.allowedCodes.map((code) => `      ${stringLiteral(code)},`).join('\n')}
    ],
  },
} as const;
`;
}

function renderLiveSmokeProbe(source, wrapperSha256) {
  const pattern = /^PACKAGE_RUNC_SHA256 = "[a-f0-9]{64}"$/gmu;
  const matches = source.match(pattern);
  if (matches?.length !== 1) {
    throw new Error('nested-Docker live-smoke probe must contain exactly one canonical package runtime digest');
  }
  return source.replace(pattern, `PACKAGE_RUNC_SHA256 = "${wrapperSha256}"`);
}

function atomicWrite(path, contents, modeBits) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  writeFileSync(temporary, contents, { flag: 'wx', mode: modeBits });
  chmodSync(temporary, modeBits);
  renameSync(temporary, path);
}

function requireExact(path, expected, expectedMode) {
  let actual;
  try {
    actual = readFileSync(path);
  } catch (error) {
    throw new Error(`${path} is missing; run node build.mjs --write`, { cause: error });
  }
  if (!actual.equals(expected)) {
    throw new Error(`${path} is stale; run node build.mjs --write`);
  }
  const actualMode = statSync(path).mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new Error(
      `${path} mode is ${actualMode.toString(8).padStart(4, '0')}, expected ${expectedMode.toString(8).padStart(4, '0')}`,
    );
  }
}
