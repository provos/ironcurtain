import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAndAdjudicateVulnerabilityFixtureReport } from '../../src/docker-workload/scanner-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('vulnerability fixture report adjudication', () => {
  it.each([
    ['vulnerable', [{ id: 'ICV-FIXTURE-0001', severity: 'high', evidence: 'deterministic debug diagnostic exposed' }]],
    ['patched', []],
  ] as const)('accepts the exact %s verdict', (expected, findings) => {
    const path = writeReport({ findings });
    expect(loadAndAdjudicateVulnerabilityFixtureReport(path, expected).findings).toHaveLength(findings.length);
  });

  it.each([
    '{',
    JSON.stringify({
      schemaVersion: 1,
      scanner: 'wrong',
      target: 'http://target:8080',
      status: 'completed',
      findings: [],
    }),
    JSON.stringify({
      schemaVersion: 1,
      scanner: 'ironcurtain-fixture-scanner-v1',
      target: 'http://target:8080',
      status: 'completed',
      findings: [],
      ignored: true,
    }),
  ])('rejects malformed or non-canonical scanner output', (contents) => {
    const path = writeRaw(contents);
    expect(() => loadAndAdjudicateVulnerabilityFixtureReport(path, 'patched')).toThrow(/malformed|schema/u);
  });

  it('rejects a wrong positive/negative verdict and a symlink report', () => {
    const path = writeReport({ findings: [] });
    expect(() => loadAndAdjudicateVulnerabilityFixtureReport(path, 'vulnerable')).toThrow(/verdict mismatch/u);
    const link = `${path}.link`;
    symlinkSync(path, link);
    expect(() => loadAndAdjudicateVulnerabilityFixtureReport(link, 'patched')).toThrow(/non-symlink/u);
  });
});

function writeReport(options: { readonly findings: readonly unknown[] }): string {
  return writeRaw(
    JSON.stringify({
      schemaVersion: 1,
      scanner: 'ironcurtain-fixture-scanner-v1',
      target: 'http://target:8080',
      status: 'completed',
      findings: options.findings,
    }),
  );
}

function writeRaw(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'scanner-fixture-report-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'report.json');
  writeFileSync(path, `${contents}\n`, { mode: 0o600 });
  return path;
}
