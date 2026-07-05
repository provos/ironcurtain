/**
 * Resolves the `ironcurtain` binary (or the runtime that can execute it) plus any
 * prefix args needed to spawn a child `ironcurtain start --pty` process.
 *
 * When the current process runs from a .ts entry point (tsx/ts-node), the child
 * must be spawned through the same runtime with the loader flags from
 * `process.execArgv`; otherwise the compiled JS entry / installed bin is used
 * directly. Shared by `mux/` (CLI) and `web-ui/` (daemon PTY sessions) so both
 * compute the child argv identically -- a leaf under src/pty/.
 */

export interface ResolvedIroncurtainBin {
  /** The executable to spawn (the runtime like `node`, or the ironcurtain bin). */
  readonly bin: string;
  /** Args inserted before the `start` subcommand (tsx loader flags + script path). */
  readonly prefixArgs: string[];
}

export function resolveIroncurtainBin(): ResolvedIroncurtainBin {
  const script = process.argv[1];
  // If the entry point is a .ts file, we're running via tsx/ts-node --
  // spawn the child through the same runtime. process.execArgv contains
  // the loader flags (e.g. --import tsx/loader) that make .ts imports work.
  if (script && script.endsWith('.ts')) {
    return { bin: process.argv[0], prefixArgs: [...process.execArgv, script] };
  }
  // If running a compiled JS file or via an installed bin, use it directly
  return { bin: script || 'ironcurtain', prefixArgs: [] };
}
