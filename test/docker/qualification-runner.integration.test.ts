import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVitestQualificationCommand } from '../../src/docker-workload/qualification-runner.js';
import type { QualificationContract } from '../../src/docker/qualification-contract.js';

const enabled = process.env.QUALIFICATION_RUNNER_INTEGRATION === '1';

describe.skipIf(!enabled)('real local Vitest qualification runner', () => {
  it('emits and self-verifies the stock JSON report for one exact test selection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qualification-runner-integration-'));
    chmodSync(directory, 0o700);
    const evidenceDirectory = join(directory, 'evidence');
    mkdirSync(evidenceDirectory, { mode: 0o700 });
    chmodSync(evidenceDirectory, 0o700);
    const contractPath = join(directory, 'contract.json');
    const contract: QualificationContract = {
      schemaVersion: 1,
      contractId: 'phase0f-runner-integration-v1',
      variant: 'phase0f-local-runner',
      platform: 'apple-container',
      architecture: 'arm64',
      bindings: {
        sourceCommit: '1'.repeat(40),
        dirtyPatchSha256: null,
        runtimeImageId: `sha256:${'2'.repeat(64)}`,
        publicCaSha256: '3'.repeat(64),
        catalogSha256: '4'.repeat(64),
        profileSha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
        performanceBudgetSha256: '7'.repeat(64),
        runtimeTrustSchema: 'runtime-trust-v1',
        relaySha256: null,
        watchdogSha256: '8'.repeat(64),
        buildEgressSha256: null,
      },
      commands: [
        {
          id: 'preloaded-staging-unit',
          kind: 'vitest',
          disposition: 'required-pass',
          argv: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'test/docker/preloaded-image-staging.test.ts'],
          expectedTestFiles: ['test/docker/preloaded-image-staging.test.ts'],
          expectedTestCount: 1,
        },
      ],
    };
    writeFileSync(contractPath, JSON.stringify(contract), { mode: 0o400 });
    chmodSync(contractPath, 0o400);
    try {
      const result = await runVitestQualificationCommand({
        contractPath,
        commandId: 'preloaded-staging-unit',
        repositoryRoot: resolve('.'),
        evidenceDirectory,
        timeoutMs: 30_000,
      });
      expect(result.verified).toMatchObject({ commandId: 'preloaded-staging-unit', testCount: 1 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
