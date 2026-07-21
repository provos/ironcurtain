/** Strict adjudication for the deterministic nested target/scanner fixture. */

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const VULNERABILITY_FIXTURE_FINDING_ID = 'ICV-FIXTURE-0001';
export const MAX_VULNERABILITY_FIXTURE_REPORT_BYTES = 1024 * 1024;

const findingSchema = z
  .object({
    id: z.literal(VULNERABILITY_FIXTURE_FINDING_ID),
    severity: z.literal('high'),
    evidence: z.literal('deterministic debug diagnostic exposed'),
  })
  .strict();

const reportSchema = z
  .object({
    schemaVersion: z.literal(1),
    scanner: z.literal('ironcurtain-fixture-scanner-v1'),
    target: z.literal('http://target:8080'),
    status: z.literal('completed'),
    findings: z.array(findingSchema).max(1),
  })
  .strict();

export type VulnerabilityFixtureReport = z.infer<typeof reportSchema>;

export function loadAndAdjudicateVulnerabilityFixtureReport(
  path: string,
  expected: 'vulnerable' | 'patched',
): VulnerabilityFixtureReport {
  if (!isAbsolute(path)) throw new Error('vulnerability fixture report path must be absolute');
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`vulnerability fixture report must be a readable regular non-symlink file: ${path}`, {
      cause: error,
    });
  }
  let bytes: Buffer;
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('vulnerability fixture report must be a regular file');
    if (stats.size < 2 || stats.size > MAX_VULNERABILITY_FIXTURE_REPORT_BYTES) {
      throw new Error(`vulnerability fixture report size is invalid: ${stats.size}`);
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('vulnerability fixture report is malformed JSON', { cause: error });
  }
  const validated = reportSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`vulnerability fixture report schema mismatch: ${validated.error.issues[0]?.message ?? 'invalid'}`);
  }
  const expectedFindings = expected === 'vulnerable' ? 1 : 0;
  if (validated.data.findings.length !== expectedFindings) {
    throw new Error(
      `vulnerability fixture verdict mismatch: expected ${expectedFindings} finding(s), got ${validated.data.findings.length}`,
    );
  }
  return validated.data;
}
