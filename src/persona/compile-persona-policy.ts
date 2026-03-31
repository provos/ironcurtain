/**
 * Persona policy compiler -- compiles a persona's constitution into
 * enforceable policy rules.
 *
 * Thin wrapper over PipelineRunner, following the same pattern as
 * compileTaskPolicy() in src/cron/compile-task-policy.ts. The key
 * difference is constitutionKind: 'constitution' (broad principles)
 * vs 'task-policy' (task-specific whitelist).
 */

import { readFileSync } from 'node:fs';
import { PipelineRunner, createPipelineModels } from '../pipeline/pipeline-runner.js';
import { loadConfig, getPackageGeneratedDir } from '../config/index.js';
import { getUserGeneratedDir } from '../config/paths.js';
import { getPersonaConstitutionPath, getPersonaGeneratedDir, loadPersona, applyServerAllowlist } from './resolve.js';
import type { PersonaName } from './types.js';
import type { CompiledPolicyFile } from '../pipeline/types.js';

/**
 * Compiles a persona's constitution.md into policy rules, writing
 * output to the persona's generated/ directory.
 *
 * Reads tool annotations from the global generated dir (annotations
 * are server-level, not persona-level). When the persona has a server
 * allowlist, only filtered servers are passed to the pipeline so the
 * compiled policy only references relevant tools.
 */
export async function compilePersonaPolicy(name: PersonaName): Promise<CompiledPolicyFile> {
  const config = loadConfig();
  const outputDir = getPersonaGeneratedDir(name);
  const constitutionPath = getPersonaConstitutionPath(name);
  const constitutionText = readFileSync(constitutionPath, 'utf-8');
  const annotationsDir = getUserGeneratedDir();
  const models = await createPipelineModels(outputDir);
  const runner = new PipelineRunner(models);

  // Apply server allowlist if the persona specifies one
  let mcpServers = config.mcpServers;
  const persona = loadPersona(name);
  if (persona.servers) {
    mcpServers = applyServerAllowlist(mcpServers, persona.servers);
  }

  return runner.run({
    constitutionInput: constitutionText,
    constitutionKind: 'constitution',
    outputDir,
    toolAnnotationsDir: annotationsDir,
    toolAnnotationsFallbackDir: getPackageGeneratedDir(),
    allowedDirectory: config.allowedDirectory,
    protectedPaths: config.protectedPaths,
    mcpServers,
    includeHandwrittenScenarios: false,
    prefilterText: constitutionText,
  });
}
