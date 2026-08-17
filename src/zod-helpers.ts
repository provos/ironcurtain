/**
 * Shared zod validation fragments for the Docker-workload security kernel.
 *
 * Top-level leaf (imports only zod) so both `src/docker/` and
 * `src/docker-workload/` can share the exact schema fragments and refinement
 * helpers that were duplicated across the egress and qualification modules.
 */

import { z } from 'zod';

/** Canonical HTTP header-name pattern: lowercase, hyphen-safe, 1–128 chars. */
export const HEADER_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,127}$/u;

/** Header name as a zod schema (used in request-header allow/strip lists). */
export const headerNameSchema = z.string().regex(HEADER_NAME_REGEX);

/** Lowercase dotted/dashed identifier, 3–128 chars. */
export const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u);

/** Lifecycle identifier variant that also admits a colon. */
export const lifecycleIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,127}$/u);

/** Timestamp accepted by durable lifecycle records. */
export const timestampSchema = z.iso.datetime({ offset: true });

/** Immutable runtime identity such as a container or VM ID. */
export const runtimeIdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u);

/** Runtime resource name selected before immutable identity is known. */
export const resourceNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);

/** Compact host-observed watchdog sample persisted in lifecycle records. */
export const watchdogSampleSummarySchema = z
  .object({
    sampledAtMs: z.number().int().nonnegative(),
    availableBytes: z.number().int().nonnegative(),
    allocatedBytes: z.number().int().nonnegative(),
  })
  .strict();

/** One authoritative inventory of runtime objects owned by a bundle. */
export const ownedResourceInventorySchema = z
  .object({ capturedAt: timestampSchema, ownedResourceIds: z.array(runtimeIdentitySchema).max(4096) })
  .strict();

/** Exact lifecycle cleanup proof shared by leases, evidence, and the supervisor. */
export const dockerWorkloadCleanupProofSchema = z
  .object({
    exactOuterResourcesAbsent: z.literal(true),
    stateRootAbsent: z.literal(true),
    inventories: z.tuple([ownedResourceInventorySchema, ownedResourceInventorySchema]),
  })
  .strict();

/** Canonical lowercase DNS hostname, 1–253 chars, no empty labels. */
export const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u)
  .refine(
    (value) => value === value.toLowerCase() && !value.includes('..'),
    'hostname must be canonical lowercase DNS',
  );

/** Flag repeated values in a list as custom zod issues (`duplicate ${label}: ${value}`). */
export function addDuplicateIssues(values: readonly string[], label: string, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) context.addIssue({ code: 'custom', message: `duplicate ${label}: ${value}` });
    seen.add(value);
  }
}
