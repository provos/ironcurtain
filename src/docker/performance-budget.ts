/** Frozen runtime/time/state budgets used by secure nested qualification. */

import { z } from 'zod';
import { loadImmutableHostJson } from '../hardened-fs.js';

export const PERFORMANCE_BUDGET_SCHEMA_VERSION = 1;
export const MAX_PERFORMANCE_BUDGET_BYTES = 256 * 1024;

const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u);
const versionSchema = z.string().min(1).max(256);
const durationSchema = z
  .number()
  .int()
  .positive()
  .max(24 * 60 * 60 * 1000);
const byteSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const performanceMeasurementsSchema = z
  .object({
    daemonReadinessMs: z.number().int().nonnegative(),
    primitiveSuiteMs: z.number().int().nonnegative(),
    ironcurtainBuildMs: z.number().int().nonnegative(),
    scannerWorkflowMs: z.number().int().nonnegative(),
    mandatorySuiteMs: z.number().int().nonnegative(),
    wholeQualificationMs: z.number().int().nonnegative(),
    peakOwnedStateBytes: byteSchema,
    retainedOwnedStateBytes: byteSchema,
  })
  .strict();

const performanceBudgetSchema = z
  .object({
    schemaVersion: z.literal(PERFORMANCE_BUDGET_SCHEMA_VERSION),
    budgetId: identifierSchema,
    platform: z.enum(['docker-desktop', 'apple-container', 'linux-docker']),
    variant: identifierSchema,
    architecture: z.enum(['amd64', 'arm64']),
    versionScope: z
      .object({
        outerRuntime: versionSchema,
        innerDocker: versionSchema,
        storageDriver: identifierSchema,
      })
      .strict(),
    maxima: z
      .object({
        daemonReadinessMs: durationSchema,
        primitiveSuiteMs: durationSchema,
        ironcurtainBuildMs: durationSchema,
        scannerWorkflowMs: durationSchema,
        mandatorySuiteMs: durationSchema,
        wholeQualificationMs: durationSchema,
        peakOwnedStateBytes: byteSchema.positive(),
        retainedOwnedStateBytes: byteSchema,
      })
      .strict(),
  })
  .strict();

export type PerformanceBudget = z.infer<typeof performanceBudgetSchema>;
export type PerformanceMeasurements = z.infer<typeof performanceMeasurementsSchema>;

export interface LoadedPerformanceBudget {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly budget: PerformanceBudget;
}

export interface PerformanceBudgetResult {
  readonly budgetId: string;
  readonly passed: true;
  readonly headroom: Readonly<Record<keyof PerformanceMeasurements, number>>;
}

export interface PerformanceBudgetScope {
  readonly platform: PerformanceBudget['platform'];
  readonly variant: string;
  readonly architecture: PerformanceBudget['architecture'];
  readonly outerRuntime: string;
  readonly innerDocker: string;
  readonly storageDriver: string;
}

export function loadPerformanceBudget(path: string): LoadedPerformanceBudget {
  const loaded = loadImmutableHostJson(path, {
    label: 'performance budget',
    schema: performanceBudgetSchema,
    maxBytes: MAX_PERFORMANCE_BUDGET_BYTES,
  });
  return { path: loaded.path, sha256: loaded.sha256, sizeBytes: loaded.sizeBytes, budget: loaded.value };
}

/** Reject selecting a budget measured for another concrete runtime tuple. */
export function assertPerformanceBudgetScope(budget: PerformanceBudget, scope: PerformanceBudgetScope): void {
  const validated = performanceBudgetSchema.parse(budget);
  const expected = {
    platform: validated.platform,
    variant: validated.variant,
    architecture: validated.architecture,
    outerRuntime: validated.versionScope.outerRuntime,
    innerDocker: validated.versionScope.innerDocker,
    storageDriver: validated.versionScope.storageDriver,
  };
  const mismatches = (Object.keys(expected) as Array<keyof PerformanceBudgetScope>).filter(
    (field) => scope[field] !== expected[field],
  );
  if (mismatches.length !== 0) {
    throw new Error(`performance budget scope mismatch for ${validated.budgetId}: ${mismatches.join(', ')}`);
  }
}

/** Every metric is mandatory and bounded; qualification cannot self-relax. */
export function assertPerformanceWithinBudget(
  budget: PerformanceBudget,
  measurements: PerformanceMeasurements,
): PerformanceBudgetResult {
  const validatedBudget = performanceBudgetSchema.parse(budget);
  const validatedMeasurements = performanceMeasurementsSchema.parse(measurements);
  const metrics = Object.keys(validatedMeasurements) as Array<keyof PerformanceMeasurements>;
  const exceeded = metrics.filter((metric) => validatedMeasurements[metric] > validatedBudget.maxima[metric]);
  if (exceeded.length > 0) {
    const detail = exceeded
      .map((metric) => `${metric}=${validatedMeasurements[metric]} > ${validatedBudget.maxima[metric]}`)
      .join(', ');
    throw new Error(`performance budget exceeded for ${validatedBudget.budgetId}: ${detail}`);
  }
  return {
    budgetId: validatedBudget.budgetId,
    passed: true,
    headroom: Object.fromEntries(
      metrics.map((metric) => [metric, validatedBudget.maxima[metric] - validatedMeasurements[metric]]),
    ) as Record<keyof PerformanceMeasurements, number>,
  };
}
