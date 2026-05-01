import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validateDefinition } from '../src/workflow/validate.js';
import { AppSecFindingsFileSchema } from '../src/appsec/findings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(__dirname, '..', 'src', 'workflow', 'workflows', 'appsec-assessment.yaml');
const retiredWorkflowPath = resolve(__dirname, '..', 'src', 'workflow', 'workflows', 'vuln-discovery.yaml');
const defenderConstitutionPath = resolve(__dirname, '..', 'src', 'config', 'constitution-appsec-defender.md');

describe('appsec-assessment workflow', () => {
  it('is the bundled defensive AppSec workflow', () => {
    expect(existsSync(retiredWorkflowPath)).toBe(false);

    const rawText = readFileSync(workflowPath, 'utf-8');
    const definition = validateDefinition(parseYaml(rawText, { maxAliasCount: 0 }));

    expect(definition.name).toBe('appsec-assessment');
    expect(definition.states.inventory.type).toBe('agent');
    expect(definition.states.done.type).toBe('terminal');
  });

  it('defines the standard assessment artifacts', () => {
    const rawText = readFileSync(workflowPath, 'utf-8');

    for (const artifactPath of [
      '.workflow/inventory/inventory.json',
      '.workflow/findings/findings.json',
      '.workflow/validation/validation.md',
      '.workflow/patches/patch-plan.md',
      '.workflow/report/security-assessment.md',
    ]) {
      expect(rawText).toContain(artifactPath);
    }
  });

  it('keeps prompt safety constraints defensive', () => {
    const rawText =
      readFileSync(workflowPath, 'utf-8').toLowerCase() +
      '\n' +
      readFileSync(defenderConstitutionPath, 'utf-8').toLowerCase();

    for (const forbidden of [
      'you may create standalone poc',
      'standalone poc scripts are allowed',
      'write standalone poc scripts when useful',
      'build exploit tooling when useful',
      'weaponized payloads are allowed',
      'operational exploitation steps are allowed',
    ]) {
      expect(rawText).not.toContain(forbidden);
    }

    expect(rawText).toContain('minimal internal regression fixtures are allowed only when needed');
    expect(rawText).toContain('do not create standalone poc scripts');
  });
});

describe('AppSecFinding schema', () => {
  it('accepts the V1 findings artifact shape', () => {
    const parsed = AppSecFindingsFileSchema.parse({
      generatedAt: new Date().toISOString(),
      findings: [
        {
          id: 'APPSEC-001',
          title: 'Missing authorization check',
          category: 'Authorization',
          cwe: 'CWE-862',
          affectedFiles: ['src/routes/admin.ts'],
          evidenceType: 'source-review',
          validationStatus: 'validated',
          severity: 'high',
          recommendedFix: 'Enforce object-level authorization before returning records.',
          patchStatus: 'patched',
          residualRisk: 'Residual risk depends on coverage of adjacent admin routes.',
        },
      ],
    });

    expect(parsed.findings[0]?.id).toBe('APPSEC-001');
  });
});
