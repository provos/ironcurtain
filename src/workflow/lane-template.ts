/**
 * Fan-out lane templating for the evolve workflow's per-lane working areas.
 *
 * Under N-way fan-out (`docs/designs/evolve-sync-parallelism-slice.md` §7), the
 * shared `current/` scratch directory collides across lanes, so each lane runs
 * in its own `current/lane_<k>/` sub-path. This module rewrites the three
 * surfaces that hardcode `current/`: agent prompts (via `{laneDir}`/`{laneId}`
 * placeholders, §7.3), deterministic argv paths (via current-prefix rewriting,
 * §7.1), and the per-lane `--lane <k>` flag the bridge reads (§7.1/§8.4).
 *
 * ESCAPING INVARIANT (read before adding a new caller). Every substitution here
 * is a LITERAL text replacement, and the substituted values are
 * orchestrator-controlled trusted lane identities: `lane.id` is a non-negative
 * integer the orchestrator assigns (`buildFanOutLaneContext`), and `lane.dir` /
 * `lane.relativeDir` are orchestrator-computed `…/current/lane_<id>` paths — none
 * of them ever carry agent- or user-authored text. The rendered result is
 * concatenated into a prompt (free text) or an argv array, so NO shell, markdown,
 * or argv escaping is performed here. That is sound ONLY because of this
 * invariant. A future caller MUST NOT template untrusted data (agent output, user
 * input, file contents) through these helpers — doing so would inject unescaped
 * text into a prompt/argv. If you need to interpolate untrusted data, escape it
 * at the call site first; do not relax this module to do it for you.
 */
import type { WorkflowContext, FanOutDefinition, WorkflowSettings } from './types.js';

/**
 * Resolves the effective lane count for a fan-out state, exactly as the runtime
 * does at `orchestrator.ts` (`runFanOutSegment`): `count: 'workers'` defers to
 * `settings.workers` (default 1), while a numeric `count` is a per-state override
 * independent of the global worker count.
 *
 * Single source of truth so the validator and linter gate their multi-lane
 * safety checks on the SAME lane count the runtime will spin up — a numeric
 * `count` override must not be able to bypass those checks just because
 * `settings.workers` is 1. Keep in lockstep with the orchestrator's resolution.
 */
export function resolveFanOutWorkers(fanOut: FanOutDefinition, settings?: WorkflowSettings): number {
  return fanOut.count === 'workers' ? (settings?.workers ?? 1) : fanOut.count;
}

// Lane-dir format seam: `current/lane_<k>`. The matching step-name half of this
// convention lives on the Python side as STEP_NAME_RE in
// scripts/evolve_result.py (`step_<NNNN>_lane_<k>`) — keep both in sync if the
// lane/step naming ever changes.
export const DEFAULT_EVOLVE_LANE_DIR = '/workspace/.evolve_runs/main/current';

/**
 * Zero-pad width of the `step_<NNNN>` batch index. Mirrors the Python `:04d`
 * format in `scripts/evolve_result.py` (`step_{batch_index:04d}_lane_{lane}`).
 */
export const EVOLVE_STEP_INDEX_WIDTH = 4;

/**
 * The single TS spelling of the fan-out step name `step_<NNNN>_lane_<k>` (the
 * other half of the lane-dir seam above). The Python bridge writes the same
 * literal at `f"step_{batch_index:04d}_lane_{lane}"`; the orchestrator parses it
 * back with EVOLVE_LANE_STEP_RE. Keep all three (this fn, the Python f-string,
 * the regex) in lockstep — they are one cross-language format contract.
 */
export function evolveStepName(batchIndex: number, lane: number): string {
  return `step_${String(batchIndex).padStart(EVOLVE_STEP_INDEX_WIDTH, '0')}_lane_${lane}`;
}
export const DEFAULT_EVOLVE_LANE_RELATIVE_DIR = '.evolve_runs/main/current';

/**
 * The bridge script basename. Exported so the orchestrator matches fan-out
 * sample commands against the same literal this module uses for `--lane`
 * injection, instead of re-spelling the find/`endsWith` matcher (see
 * {@link evolveResultScriptIndex}).
 */
export const EVOLVE_RESULT_SCRIPT = 'evolve_result.py';

const EVOLVE_LANE_AWARE_COMMANDS = new Set(['sample', 'evaluate', 'record', 'attach_analysis']);

function laneId(context: WorkflowContext): string {
  return String(context.lane?.id ?? 0);
}

function laneDir(context: WorkflowContext): string {
  return context.lane?.dir ?? DEFAULT_EVOLVE_LANE_DIR;
}

function laneRelativeDir(context: WorkflowContext): string {
  return context.lane?.relativeDir ?? DEFAULT_EVOLVE_LANE_RELATIVE_DIR;
}

/**
 * Substitutes the `{laneDir}` / `{laneRelativeDir}` / `{laneRelDir}` /
 * `{laneId}` / `${laneId}` placeholders in `value` with this lane's trusted
 * identity (falling back to the bare `current/` dir and lane id `0` when no lane
 * is active, so `workers: 1` renders the legacy paths). Pure literal replacement
 * — see the module's ESCAPING INVARIANT.
 */
export function applyLaneTemplate(value: string, context: WorkflowContext): string {
  let rendered = value;
  rendered = rendered.replaceAll('{laneDir}', laneDir(context));
  rendered = rendered.replaceAll('{laneRelativeDir}', laneRelativeDir(context));
  rendered = rendered.replaceAll('{laneRelDir}', laneRelativeDir(context));
  rendered = rendered.replaceAll('${laneId}', laneId(context));
  rendered = rendered.replaceAll('{laneId}', laneId(context));
  return rendered;
}

/**
 * Lane-scopes a path: first applies the placeholder templating, then rewrites a
 * bare `…/current/<rest>` prefix to `…/current/lane_<k>/<rest>` (both the
 * container-absolute `DEFAULT_EVOLVE_LANE_DIR` and the workspace-relative
 * `DEFAULT_EVOLVE_LANE_RELATIVE_DIR` forms). Returns `value` unchanged when no
 * lane is active. See the module's ESCAPING INVARIANT for why the values are
 * trusted.
 */
export function laneScopeEvolveCurrentPath(value: string, context: WorkflowContext): string {
  const lane = context.lane;
  if (!lane) return applyLaneTemplate(value, context);

  let rendered = applyLaneTemplate(value, context);
  rendered = replaceCurrentPrefix(rendered, DEFAULT_EVOLVE_LANE_DIR, lane.dir);
  rendered = replaceCurrentPrefix(rendered, DEFAULT_EVOLVE_LANE_RELATIVE_DIR, lane.relativeDir);
  return rendered;
}

/**
 * Lane-scopes every path argument in a deterministic `run:` command, then
 * injects `--lane <id>` after the bridge subcommand for the lane-aware
 * subcommands ({@link EVOLVE_LANE_AWARE_COMMANDS}). Returns the command
 * unchanged when no lane is active. See the module's ESCAPING INVARIANT.
 */
export function templateLaneCommand(command: readonly string[], context: WorkflowContext): readonly string[] {
  const templated = command.map((arg) => laneScopeEvolveCurrentPath(arg, context));
  const lane = context.lane;
  if (!lane) return templated;
  return injectEvolveLaneArg(templated, lane.id);
}

/**
 * Finds the index of the {@link EVOLVE_RESULT_SCRIPT} bridge entry in a command
 * argv (matching either the bare basename or any `…/evolve_result.py` path), or
 * `-1` if absent. The single source of truth for locating the bridge so the
 * orchestrator and the `--lane` injector agree on what counts as the script.
 */
export function evolveResultScriptIndex(command: readonly string[]): number {
  return command.findIndex((arg) => arg === EVOLVE_RESULT_SCRIPT || arg.endsWith(`/${EVOLVE_RESULT_SCRIPT}`));
}

function replaceCurrentPrefix(value: string, currentDir: string, replacement: string): string {
  if (value === currentDir) return replacement;
  const prefix = `${currentDir}/`;
  if (!value.startsWith(prefix)) return value;
  const suffix = value.slice(prefix.length);
  // Idempotency guard: a path already lane-scoped (`current/lane_<n>/…`) must
  // not be re-prefixed into `current/lane_<k>/lane_<n>/…`. This makes the rewrite
  // safe to apply more than once (e.g. an argv that was templated upstream and
  // re-templated here) and protects manifest paths that hardcode `lane_${laneId}`
  // — applyLaneTemplate already expanded those, so the literal `lane_<n>/` they
  // produce must be left alone. The flip side: a manifest that hardcodes a literal
  // `lane_<digit>/` (no `${laneId}` to expand) is left UNCHANGED by every lane and
  // would clobber — the validator (`HARDCODED_LANE_RESULT_FILE_RE` in validate.ts)
  // rejects exactly that, matching this guard's `/^lane_\d+\//` notion of "a lane
  // segment"; the two must stay consistent.
  if (/^lane_\d+\//.test(suffix)) return value;
  return `${replacement}/${suffix}`;
}

function injectEvolveLaneArg(command: readonly string[], id: number): readonly string[] {
  if (command.includes('--lane')) return command;
  const scriptIndex = evolveResultScriptIndex(command);
  if (scriptIndex < 0) return command;
  const subcommandIndex = scriptIndex + 1;
  const subcommand = command[subcommandIndex];
  if (!EVOLVE_LANE_AWARE_COMMANDS.has(subcommand)) return command;
  return [...command.slice(0, subcommandIndex + 1), '--lane', String(id), ...command.slice(subcommandIndex + 1)];
}
