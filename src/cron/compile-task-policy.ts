/**
 * Task policy compiler -- compiles a task-scoped policy from an
 * English task description.
 *
 * Convenience wrapper over PipelineRunner with task-policy defaults.
 * Loads MCP server configs via loadConfig() to preserve the structural
 * domain-gate protection for URL-role arguments.
 */

import { resolve } from 'node:path';
import { PipelineRunner, createPipelineModels } from '../pipeline/pipeline-runner.js';
import { loadConfig } from '../config/index.js';
import { getUserGeneratedDir } from '../config/paths.js';
import { getPackageGeneratedDir } from '../config/index.js';
import type { CompiledPolicyFile } from '../pipeline/types.js';

/**
 * Compiles a task-scoped policy from an English task description.
 *
 * @param taskDescription The English task description to compile into policy rules.
 * @param jobDir The job directory (contains generated/ and workspace/ subdirectories).
 * @param globalAnnotationsDir Directory containing tool-annotations.json (defaults to user generated dir).
 */
export async function compileTaskPolicy(
  taskDescription: string,
  jobDir: string,
  globalAnnotationsDir?: string,
): Promise<CompiledPolicyFile> {
  const config = loadConfig();
  const outputDir = resolve(jobDir, 'generated');
  const annotationsDir = globalAnnotationsDir ?? getUserGeneratedDir();
  const models = await createPipelineModels(outputDir);
  const runner = new PipelineRunner(models);

  return runner.run({
    constitutionInput: taskDescription,
    constitutionKind: 'task-policy',
    outputDir,
    toolAnnotationsDir: annotationsDir,
    toolAnnotationsFallbackDir: getPackageGeneratedDir(),
    allowedDirectory: resolve(jobDir, 'workspace'),
    protectedPaths: config.protectedPaths,
    mcpServers: config.mcpServers,
    includeHandwrittenScenarios: false,
  });
}
