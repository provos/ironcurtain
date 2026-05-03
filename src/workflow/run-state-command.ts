/**
 * `ironcurtain workflow run-state` — runs a single workflow agent state once
 * against a pre-staged artifact directory. Reuses the start-time staging and
 * session-factory seams; deliberately skips the orchestrator, journal,
 * checkpoint, and transition machinery.
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
import { formatHelp, type CommandSpec } from '../cli-help.js';
import { type LintMode } from './lint-integration.js';
import { createInitialContext } from './machine-builder.js';
import { resolveWorkflowPath, getWorkflowPackageDir } from './discovery.js';
import { buildAgentCommand } from './prompt-builder.js';
import { parseAgentStatus, AgentStatusParseError } from './status-parser.js';
import { parseArtifactRef } from './validate.js';
import { stageWorkflowSkillsAtStart } from './orchestrator.js';
import { parseArgsStrict, runCliPreflightLint } from './workflow-command.js';
import type { AgentStateDefinition, WorkflowContext, WorkflowDefinition, WorkflowStateDefinition } from './types.js';
import { WORKFLOW_ARTIFACT_DIR } from './types.js';

import {
  createWorkflowSessionFactory,
  writeStderr,
  writeStdout,
  BOLD,
  CYAN,
  DIM,
  GREEN,
  RED,
  RESET,
  YELLOW,
} from './cli-support.js';
import { createAgentConversationId } from '../session/types.js';
import type { Session, SessionMode } from '../session/types.js';
import type { AgentId } from '../docker/agent-adapter.js';

// ---------------------------------------------------------------------------
// Help spec
// ---------------------------------------------------------------------------

export const runStateSpec: CommandSpec = {
  name: 'ironcurtain workflow run-state',
  description: 'Run a single workflow agent state once against pre-staged artifacts',
  usage: ['ironcurtain workflow run-state <name-or-path> <state> --artifacts <dir> [options]'],
  options: [
    { flag: 'artifacts', description: 'Directory containing pre-staged artifact subdirs', placeholder: '<dir>' },
    {
      flag: 'workspace',
      description: 'Source tree to stage alongside .workflow/ (excludes top-level .workflow/ from the copy)',
      placeholder: '<dir>',
    },
    { flag: 'directive', description: 'Inline scoping directive from a synthetic prior agent', placeholder: '<text>' },
    { flag: 'directive-file', description: 'File containing the scoping directive', placeholder: '<path>' },
    {
      flag: 'output',
      description: 'Output dir for staged workspace (default: ~/.ironcurtain/debug-runs/...)',
      placeholder: '<dir>',
    },
    { flag: 'mode', description: 'Override settings.mode (builtin or docker)', placeholder: '<mode>' },
    {
      flag: 'task',
      description: 'Inline task description (overrides artifacts/task/description.md)',
      placeholder: '<text>',
    },
    { flag: 'task-file', description: 'File containing task description', placeholder: '<path>' },
    { flag: 'model', description: 'Override the agent model', placeholder: '<model-id>' },
    { flag: 'no-lint', description: 'Skip pre-flight linting' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain workflow run-state vuln-discovery review --artifacts ~/src/libtiff/.workflow',
    'ironcurtain workflow run-state vuln-discovery review --workspace ~/src/libtiff --artifacts ~/src/libtiff/.workflow',
    'ironcurtain workflow run-state vuln-discovery review --artifacts ~/src/libtiff/.workflow --directive "focus on the PIXARLOG finding"',
    'ironcurtain workflow run-state vuln-discovery review --artifacts ~/src/libtiff/.workflow --mode builtin',
  ],
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  readonly definitionRef: string;
  readonly stateId: string;
  readonly artifactsDir: string;
  readonly workspaceSrc: string | undefined;
  readonly directive: string | undefined;
  readonly outputDir: string | undefined;
  readonly mode: 'builtin' | 'docker' | undefined;
  readonly taskDescription: string | undefined;
  readonly modelOverride: string | undefined;
  readonly noLint: boolean;
}

function parseRunStateArgs(args: string[]): ParsedArgs | 'help' {
  const { values, positionals } = parseArgsStrict({
    args,
    options: {
      artifacts: { type: 'string' },
      workspace: { type: 'string' },
      directive: { type: 'string' },
      'directive-file': { type: 'string' },
      output: { type: 'string' },
      mode: { type: 'string' },
      task: { type: 'string' },
      'task-file': { type: 'string' },
      model: { type: 'string' },
      'no-lint': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) return 'help';

  const definitionRef = positionals[0];
  const stateId = positionals[1];
  if (!definitionRef || !stateId) {
    writeStderr(`${RED}Usage: ironcurtain workflow run-state <name-or-path> <state> --artifacts <dir>${RESET}`);
    process.exit(2);
  }

  const artifactsDir = values.artifacts as string | undefined;
  if (!artifactsDir) {
    writeStderr(`${RED}--artifacts <dir> is required${RESET}`);
    process.exit(2);
  }

  if (values.directive != null && values['directive-file'] != null) {
    writeStderr(`${RED}--directive and --directive-file are mutually exclusive${RESET}`);
    process.exit(2);
  }
  if (values.task != null && values['task-file'] != null) {
    writeStderr(`${RED}--task and --task-file are mutually exclusive${RESET}`);
    process.exit(2);
  }

  let directive: string | undefined;
  if (values.directive != null) {
    directive = values.directive as string;
  } else if (values['directive-file'] != null) {
    const path = resolve(values['directive-file'] as string);
    directive = readFileWithMessage(path, 'directive file');
  }

  let taskDescription: string | undefined;
  if (values.task != null) {
    taskDescription = values.task as string;
  } else if (values['task-file'] != null) {
    const path = resolve(values['task-file'] as string);
    taskDescription = readFileWithMessage(path, 'task file');
  }

  const modeRaw = values.mode as string | undefined;
  let mode: 'builtin' | 'docker' | undefined;
  if (modeRaw != null) {
    if (modeRaw !== 'builtin' && modeRaw !== 'docker') {
      writeStderr(`${RED}--mode must be "builtin" or "docker" (got "${modeRaw}")${RESET}`);
      process.exit(2);
    }
    mode = modeRaw;
  }

  const workspaceRaw = values.workspace as string | undefined;
  const workspaceSrc = workspaceRaw != null ? resolve(workspaceRaw) : undefined;

  return {
    definitionRef,
    stateId,
    artifactsDir: resolve(artifactsDir),
    workspaceSrc,
    directive,
    outputDir: values.output != null ? resolve(values.output as string) : undefined,
    mode,
    taskDescription,
    modelOverride: values.model as string | undefined,
    noLint: values['no-lint'] === true,
  };
}

function readFileWithMessage(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    writeStderr(`${RED}${label} not found: ${path}${RESET}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Workflow + state resolution
// ---------------------------------------------------------------------------

interface ResolvedAgentState {
  readonly definition: WorkflowDefinition;
  readonly definitionPath: string;
  readonly stateConfig: AgentStateDefinition;
}

function resolveAgentState(parsed: ParsedArgs): ResolvedAgentState {
  const definitionPath = resolveWorkflowPath(parsed.definitionRef);
  if (!definitionPath) {
    writeStderr(`${RED}Workflow not found: ${parsed.definitionRef}${RESET}`);
    writeStderr(`${DIM}Looked in bundled and user workflow directories.${RESET}`);
    process.exit(2);
  }

  const lintMode: LintMode = parsed.noLint ? 'off' : 'warn';
  const definition = runCliPreflightLint(definitionPath, lintMode);

  if (!Object.prototype.hasOwnProperty.call(definition.states, parsed.stateId)) {
    const agentStates = Object.entries(definition.states)
      .filter(([, s]) => s.type === 'agent')
      .map(([id]) => id);
    writeStderr(`${RED}Unknown state: "${parsed.stateId}"${RESET}`);
    writeStderr(`${DIM}Available agent states: ${agentStates.join(', ')}${RESET}`);
    process.exit(2);
  }
  const stateConfig: WorkflowStateDefinition = definition.states[parsed.stateId];
  if (stateConfig.type !== 'agent') {
    writeStderr(
      `${RED}state "${parsed.stateId}" is type "${stateConfig.type}"; only agent states are runnable${RESET}`,
    );
    process.exit(2);
  }

  return { definition, definitionPath, stateConfig };
}

// ---------------------------------------------------------------------------
// Workspace + artifact staging
// ---------------------------------------------------------------------------

function defaultOutputDir(workflowName: string, stateId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(getIronCurtainHome(), 'debug-runs', `${workflowName}-${stateId}-${ts}`);
}

interface StagedWorkspace {
  readonly outputDir: string;
  readonly workspacePath: string;
  readonly artifactDir: string;
}

function assertDirectory(path: string, flag: string): void {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    writeStderr(`${RED}${flag} is not a directory: ${path}${RESET}`);
    process.exit(2);
  }
  if (!stat.isDirectory()) {
    writeStderr(`${RED}${flag} is not a directory: ${path}${RESET}`);
    process.exit(2);
  }
}

/**
 * Stages the agent's workspace under {@link outputDir}/workspace, copying every
 * subdirectory of {@link artifactsSrc} whose name matches one of the state's
 * declared inputs. Required inputs (no `?`) missing on disk produce a
 * structured exit-2 error listing each missing input and the path it was
 * looked up at; optional inputs are silently skipped.
 *
 * If {@link workspaceSrc} is provided, its contents are copied first into the
 * staged workspace, EXCLUDING any top-level `.workflow/` directory (which
 * would conflict with the artifact staging step that runs after). Artifact
 * staging always wins on conflict.
 *
 * The source dirs are never mutated — only read.
 */
function stageWorkspace(
  outputDir: string,
  artifactsSrc: string,
  inputs: readonly string[],
  workspaceSrc: string | undefined,
): StagedWorkspace {
  assertDirectory(artifactsSrc, '--artifacts');
  if (workspaceSrc != null) assertDirectory(workspaceSrc, '--workspace');
  let existingEntries: string[] = [];
  try {
    existingEntries = readdirSync(outputDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') {
      writeStderr(`${RED}--output exists but is not a directory: ${outputDir}${RESET}`);
      process.exit(2);
    }
    if (code !== 'ENOENT') {
      writeStderr(
        `${RED}Cannot read --output dir ${outputDir}: ${err instanceof Error ? err.message : String(err)}${RESET}`,
      );
      process.exit(2);
    }
  }
  if (existingEntries.length > 0) {
    writeStderr(`${RED}Output dir already exists and is not empty: ${outputDir}${RESET}`);
    writeStderr(`${DIM}Choose a different --output, or remove the existing directory.${RESET}`);
    process.exit(2);
  }
  const workspacePath = resolve(outputDir, 'workspace');
  const artifactDir = resolve(workspacePath, WORKFLOW_ARTIFACT_DIR);
  mkdirSync(artifactDir, { recursive: true });

  if (workspaceSrc != null) {
    const skip = resolve(workspaceSrc, WORKFLOW_ARTIFACT_DIR);
    cpSync(workspaceSrc, workspacePath, { recursive: true, filter: (src) => resolve(src) !== skip });
  }

  const missing: string[] = [];
  for (const inputRef of inputs) {
    const { name, isOptional } = parseArtifactRef(inputRef);
    const srcPath = resolve(artifactsSrc, name);
    let srcStat;
    try {
      srcStat = statSync(srcPath);
    } catch {
      if (!isOptional) missing.push(`${name} (looked up at ${srcPath})`);
      continue;
    }
    if (!srcStat.isDirectory()) {
      if (isOptional) {
        writeStderr(`${YELLOW}Warning: optional input ${srcPath} is not a directory; skipping.${RESET}`);
        continue;
      }
      writeStderr(`${RED}Required input ${name} at ${srcPath} is not a directory${RESET}`);
      process.exit(2);
    }
    cpSync(srcPath, resolve(artifactDir, name), { recursive: true });
  }

  if (missing.length > 0) {
    writeStderr(`${RED}Missing required inputs:${RESET}`);
    for (const m of missing) writeStderr(`  ${RED}- ${m}${RESET}`);
    process.exit(2);
  }

  return { outputDir, workspacePath, artifactDir };
}

// ---------------------------------------------------------------------------
// Task description resolution
// ---------------------------------------------------------------------------

function resolveTaskDescription(parsed: ParsedArgs): string {
  if (parsed.taskDescription != null) return parsed.taskDescription.trim();

  const candidate = resolve(parsed.artifactsDir, 'task', 'description.md');
  try {
    return readFileSync(candidate, 'utf-8').trim();
  } catch {
    writeStderr(`${YELLOW}Warning: no task description found (tried ${candidate}); using placeholder.${RESET}`);
    return '(no task description provided)';
  }
}

// ---------------------------------------------------------------------------
// Context synthesis
// ---------------------------------------------------------------------------

function buildContext(
  definition: WorkflowDefinition,
  taskDescription: string,
  stateId: string,
  directive: string | undefined,
): WorkflowContext {
  return {
    ...createInitialContext(definition),
    taskDescription,
    round: 1,
    maxRounds: 1,
    previousAgentOutput: directive ?? null,
    previousStateName: directive != null ? 'debug' : null,
    visitCounts: { [stateId]: 1 },
  };
}

// ---------------------------------------------------------------------------
// Mode + session creation
// ---------------------------------------------------------------------------

function resolveMode(definition: WorkflowDefinition, override: 'builtin' | 'docker' | undefined): SessionMode {
  const settings = definition.settings ?? {};
  const effective = override ?? settings.mode ?? 'docker';
  if (effective === 'builtin') return { kind: 'builtin' };
  return { kind: 'docker', agent: (settings.dockerAgent ?? 'claude-code') as AgentId };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runRunState(args: string[]): Promise<void> {
  const parsed = parseRunStateArgs(args);
  if (parsed === 'help') {
    process.stderr.write(formatHelp(runStateSpec) + '\n');
    return;
  }

  const { definition, definitionPath, stateConfig } = resolveAgentState(parsed);

  const outputDir = parsed.outputDir ?? defaultOutputDir(definition.name, parsed.stateId);
  const staged = stageWorkspace(outputDir, parsed.artifactsDir, stateConfig.inputs, parsed.workspaceSrc);

  const workflowSkillsDir = stageWorkflowSkillsAtStart(getWorkflowPackageDir(definitionPath), outputDir);
  const skillFilter = stateConfig.skills ? new Set(stateConfig.skills) : undefined;

  const taskDescription = resolveTaskDescription(parsed);
  const context = buildContext(definition, taskDescription, parsed.stateId, parsed.directive);
  const command = buildAgentCommand(parsed.stateId, stateConfig, context, definition);

  const mode = resolveMode(definition, parsed.mode);
  const settings = definition.settings ?? {};
  const effectiveModel = stateConfig.model ?? settings.model;

  const sessionFactory = createWorkflowSessionFactory(parsed.modelOverride);

  writeStdout(`${BOLD}${CYAN}Running state "${parsed.stateId}" from ${definition.name}${RESET}`);
  writeStdout(`${DIM}Workspace: ${staged.workspacePath}${RESET}`);
  writeStdout(`${DIM}Mode: ${mode.kind}${RESET}`);
  if (parsed.directive)
    writeStdout(`${DIM}Directive: ${parsed.directive.length} bytes from synthetic "debug" agent${RESET}`);
  writeStdout('');

  let session: Session;
  try {
    session = await sessionFactory({
      persona: stateConfig.persona,
      mode,
      agentConversationId: createAgentConversationId(),
      workspacePath: staged.workspacePath,
      ...(definition.settings?.systemPrompt ? { systemPromptAugmentation: definition.settings.systemPrompt } : {}),
      ...(effectiveModel != null ? { agentModelOverride: effectiveModel } : {}),
      ...(settings.maxSessionSeconds != null
        ? { resourceBudgetOverrides: { maxSessionSeconds: settings.maxSessionSeconds } }
        : {}),
      workflow: {
        ...(workflowSkillsDir !== undefined ? { skillsDir: workflowSkillsDir } : {}),
        ...(skillFilter ? { skillFilter } : {}),
      },
    });
  } catch (err) {
    writeStderr(`${RED}Session creation failed: ${err instanceof Error ? err.message : String(err)}${RESET}`);
    process.exit(1);
  }

  let responseText = '';
  try {
    responseText = await session.sendMessage(command);
  } catch (err) {
    writeStderr(`${RED}Agent invocation failed: ${err instanceof Error ? err.message : String(err)}${RESET}`);
    await session.close().catch(() => {});
    process.exit(1);
  }

  await session.close().catch(() => {});

  // Sidecar — agent response can be megabytes; stderr is inconvenient to recover from CI logs.
  const outputFile = resolve(outputDir, 'agent-output.md');
  writeFileSync(outputFile, responseText, 'utf-8');

  let verdictLine: string;
  try {
    const parsedStatus = parseAgentStatus(responseText);
    verdictLine = parsedStatus
      ? `verdict=${parsedStatus.verdict}` + (parsedStatus.notes ? `\nnotes: ${parsedStatus.notes}` : '')
      : '(no agent_status block)';
  } catch (err) {
    if (err instanceof AgentStatusParseError) {
      verdictLine = `(malformed agent_status: ${err.message})`;
    } else {
      throw err;
    }
  }

  writeStdout('');
  writeStdout(`${BOLD}${GREEN}Result${RESET}`);
  writeStdout(verdictLine);
  writeStdout('');
  writeStdout(`${DIM}Workspace: ${staged.workspacePath}${RESET}`);
  writeStdout(`${DIM}Agent output: ${outputFile}${RESET}`);
}
