import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadQualificationContract, type QualificationContract } from '../../src/docker/qualification-contract.js';
import { verifyQualificationArtifactBindings } from '../../src/docker-workload/qualification-artifacts.js';

const CONTRACT_PATH = join(
  process.cwd(),
  'config/docker-workload/qualification-contract.apple-rootless-vfs.arm64.json',
);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A detached copy of the committed contract; mutating it never touches the frozen file. */
function frozenContract(): QualificationContract {
  return structuredClone(loadQualificationContract(CONTRACT_PATH).value);
}

type BindingMutation = (bindings: QualificationContract['bindings']) => void;

const DRIFT_CASES: readonly (readonly [string, BindingMutation])[] = [
  [
    'catalogSha256',
    (bindings) => {
      bindings.catalogSha256 = '9'.repeat(64);
    },
  ],
  [
    'runtimeImageId',
    (bindings) => {
      bindings.runtimeImageId = `sha256:${'9'.repeat(64)}`;
    },
  ],
  [
    'toolchainDigest',
    (bindings) => {
      bindings.toolchainDigest = '9'.repeat(64);
    },
  ],
  [
    'profileSha256',
    (bindings) => {
      bindings.profileSha256 = '9'.repeat(64);
    },
  ],
  [
    'watchdogSha256',
    (bindings) => {
      bindings.watchdogSha256 = '9'.repeat(64);
    },
  ],
  [
    'buildEgressSha256',
    (bindings) => {
      bindings.buildEgressSha256 = '9'.repeat(64);
    },
  ],
  [
    'runtimeTrustSchema',
    (bindings) => {
      bindings.runtimeTrustSchema = 'runtime-trust-v99';
    },
  ],
];

describe('qualification artifact binding verification', () => {
  it('accepts the committed frozen contract against the real repository', () => {
    expect(() => verifyQualificationArtifactBindings(frozenContract(), process.cwd())).not.toThrow();
  });

  // The point of the verifier: a binding is checked against the artifact, never against a copy of
  // itself. If this suite stops failing on a mutated binding, the check has become tautological.
  it.each(DRIFT_CASES)('rejects a contract whose %s does not match the artifact', (binding, mutate) => {
    const contract = frozenContract();
    mutate(contract.bindings);
    expect(() => verifyQualificationArtifactBindings(contract, process.cwd())).toThrow(
      new RegExp(`qualification binding drift: ${binding} `, 'u'),
    );
  });

  it('names both the frozen and the on-disk value so drift is diagnosable', () => {
    const contract = frozenContract();
    const frozen = contract.bindings.catalogSha256;
    contract.bindings.catalogSha256 = '9'.repeat(64);
    expect(() => verifyQualificationArtifactBindings(contract, process.cwd())).toThrow(
      `(frozen ${'9'.repeat(64)}, on disk ${frozen})`,
    );
  });

  it('reads the artifacts from the given repository root rather than trusting the contract', () => {
    const empty = mkdtempSync(join(tmpdir(), 'qualification-artifacts-'));
    temporaryDirectories.push(empty);
    expect(() => verifyQualificationArtifactBindings(frozenContract(), empty)).toThrow(
      /preloaded image catalog must be a readable regular non-symlink file/u,
    );
  });

  it('refuses a platform that has no frozen catalog rather than substituting another backend', () => {
    const contract = frozenContract();
    contract.platform = 'linux-docker';
    expect(() => verifyQualificationArtifactBindings(contract, process.cwd())).toThrow(
      /no catalog mapping for platform: linux-docker/u,
    );
  });
});
