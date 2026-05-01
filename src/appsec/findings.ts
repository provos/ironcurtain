import { z } from 'zod';

export const AppSecFindingSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'informational']);
export const AppSecFindingEvidenceTypeSchema = z.enum([
  'source-review',
  'scanner',
  'dependency-advisory',
  'secret-scan',
  'sbom',
  'internal-regression-fixture',
  'local-test',
]);
export const AppSecFindingValidationStatusSchema = z.enum([
  'unvalidated',
  'validated',
  'not-reproducible',
  'false-positive',
  'deferred',
]);
export const AppSecFindingPatchStatusSchema = z.enum([
  'not-started',
  'planned',
  'patched',
  'verified',
  'deferred',
  'not-applicable',
]);

export const AppSecFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  cwe: z.string().min(1).optional(),
  affectedFiles: z.array(z.string().min(1)),
  evidenceType: AppSecFindingEvidenceTypeSchema,
  validationStatus: AppSecFindingValidationStatusSchema,
  severity: AppSecFindingSeveritySchema,
  recommendedFix: z.string().min(1),
  patchStatus: AppSecFindingPatchStatusSchema,
  residualRisk: z.string().min(1),
});

export const AppSecFindingsFileSchema = z.object({
  generatedAt: z.iso.datetime(),
  findings: z.array(AppSecFindingSchema),
});

export type AppSecFinding = z.infer<typeof AppSecFindingSchema>;
export type AppSecFindingsFile = z.infer<typeof AppSecFindingsFileSchema>;
