import type { WorkflowContext } from './types.js';

export const DEFAULT_EVOLVE_LANE_DIR = '/workspace/.evolve_runs/main/current';
export const DEFAULT_EVOLVE_LANE_RELATIVE_DIR = '.evolve_runs/main/current';

const EVOLVE_RESULT_SCRIPT = 'evolve_result.py';
const EVOLVE_LANE_AWARE_COMMANDS = new Set(['sample', 'evaluate', 'record', 'attach_analysis']);

function replaceAllLiteral(value: string, needle: string, replacement: string): string {
  return value.split(needle).join(replacement);
}

function laneId(context: WorkflowContext): string {
  return String(context.lane?.id ?? 0);
}

function laneDir(context: WorkflowContext): string {
  return context.lane?.dir ?? DEFAULT_EVOLVE_LANE_DIR;
}

function laneRelativeDir(context: WorkflowContext): string {
  return context.lane?.relativeDir ?? DEFAULT_EVOLVE_LANE_RELATIVE_DIR;
}

export function applyLaneTemplate(value: string, context: WorkflowContext): string {
  let rendered = value;
  rendered = replaceAllLiteral(rendered, '{laneDir}', laneDir(context));
  rendered = replaceAllLiteral(rendered, '{laneRelativeDir}', laneRelativeDir(context));
  rendered = replaceAllLiteral(rendered, '{laneRelDir}', laneRelativeDir(context));
  rendered = replaceAllLiteral(rendered, '${laneId}', laneId(context));
  rendered = replaceAllLiteral(rendered, '{laneId}', laneId(context));
  return rendered;
}

export function laneScopeEvolveCurrentPath(value: string, context: WorkflowContext): string {
  const lane = context.lane;
  if (!lane) return applyLaneTemplate(value, context);

  let rendered = applyLaneTemplate(value, context);
  rendered = replaceCurrentPrefix(rendered, DEFAULT_EVOLVE_LANE_DIR, lane.dir);
  rendered = replaceCurrentPrefix(rendered, DEFAULT_EVOLVE_LANE_RELATIVE_DIR, lane.relativeDir);
  return rendered;
}

export function templateLaneCommand(command: readonly string[], context: WorkflowContext): readonly string[] {
  const templated = command.map((arg) => laneScopeEvolveCurrentPath(arg, context));
  const lane = context.lane;
  if (!lane) return templated;
  return injectEvolveLaneArg(templated, lane.id);
}

function replaceCurrentPrefix(value: string, currentDir: string, replacement: string): string {
  if (value === currentDir) return replacement;
  const prefix = `${currentDir}/`;
  if (!value.startsWith(prefix)) return value;
  const suffix = value.slice(prefix.length);
  if (/^lane_\d+\//.test(suffix)) return value;
  return `${replacement}/${suffix}`;
}

function injectEvolveLaneArg(command: readonly string[], id: number): readonly string[] {
  if (command.includes('--lane')) return command;
  const scriptIndex = command.findIndex(
    (arg) => arg === EVOLVE_RESULT_SCRIPT || arg.endsWith(`/${EVOLVE_RESULT_SCRIPT}`),
  );
  if (scriptIndex < 0) return command;
  const subcommandIndex = scriptIndex + 1;
  const subcommand = command[subcommandIndex];
  if (!EVOLVE_LANE_AWARE_COMMANDS.has(subcommand)) return command;
  return [...command.slice(0, subcommandIndex + 1), '--lane', String(id), ...command.slice(subcommandIndex + 1)];
}
