/**
 * Debug-capture helpers for `ironcurtain workflow run-state`.
 *
 * Two artifacts are extracted into the run's `--output` dir so each test
 * run owns a self-contained record of what the in-container agent saw and
 * what the container reported.
 *
 * Lifecycle notes that aren't obvious from the code:
 *   - `captureContainerLogs` MUST run BEFORE `session.close()`: the
 *     container is force-removed on close, after which `docker logs`
 *     returns "no such container".
 *   - `captureConversationLogs` runs AFTER `session.close()`: the
 *     bundle teardown only removes the runtime sockets dir, not the
 *     bind-mounted `claude-state/` tree under the session dir.
 *
 * Both are best-effort: missing/empty inputs and Docker-side failures are
 * logged to stderr but never propagated. The agent run's success/failure
 * is reported through the existing `agent-output.md` + verdict path.
 *
 * This module is run-state-only by design. Production workflow runs go
 * through the orchestrator, which has its own diagnostics; bind-mounting
 * agent state into long-lived workflow runs would cross privacy/state
 * boundaries.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSessionDir } from '../config/paths.js';
import { getBundleShortId, type BundleId } from '../session/types.js';

export interface RunStateCapturePaths {
  readonly containerLogsPath: string;
  readonly claudeLogsDir: string;
  readonly claudeProjectsSrc: string;
  readonly containerName: string;
}

export function resolveCapturePaths(bundleId: BundleId, outputDir: string): RunStateCapturePaths {
  const bundleSlug = getBundleShortId(bundleId);
  return {
    containerLogsPath: resolve(outputDir, 'container-logs.txt'),
    claudeLogsDir: resolve(outputDir, 'claude-session-logs'),
    claudeProjectsSrc: resolve(getSessionDir(bundleId), 'claude-state', 'projects'),
    containerName: `ironcurtain-${bundleSlug}`,
  };
}

/**
 * Streams `docker logs <container>` (combined stdout/stderr) to the
 * capture path. Streaming avoids the 10 MB `maxBuffer` data-loss failure
 * mode of `execFile` -- crashlooping/OOM containers, the very ones we
 * want to diagnose, are exactly the ones likely to overflow.
 */
export async function captureContainerLogs(paths: RunStateCapturePaths): Promise<void> {
  const out = createWriteStream(paths.containerLogsPath);
  const proc = spawn('docker', ['logs', paths.containerName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.pipe(out, { end: false });
  proc.stderr.pipe(out, { end: false });
  await new Promise<void>((res) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      res();
    };
    // Resolve only after the file write stream has flushed to disk.
    // `out.on('finish')` fires after `out.end()` has drained the buffer.
    out.on('finish', done);
    out.on('error', (err) => {
      process.stderr.write(`[run-state] container-log write failed: ${err.message}\n`);
      proc.kill();
      done();
    });
    // `close` (vs. `exit`) waits for the child's stdio to fully drain,
    // so any data still piping into `out` has been written by the time
    // we call `out.end()`. Resolving on `exit` could truncate large logs.
    proc.on('close', (code, signal) => {
      if (code !== 0) {
        process.stderr.write(`[run-state] docker logs ${paths.containerName} exited ${code ?? signal}\n`);
      }
      out.end();
    });
    proc.on('error', (err) => {
      process.stderr.write(`[run-state] docker logs failed: ${err.message}\n`);
      out.end();
    });
  });
}

export function captureConversationLogs(paths: RunStateCapturePaths): void {
  if (!existsSync(paths.claudeProjectsSrc)) return;
  try {
    // Skip empty source dir: an empty `claude-session-logs/` would
    // misleadingly suggest the agent ran silently when in reality it
    // crashed before writing the first JSONL frame.
    if (readdirSync(paths.claudeProjectsSrc).length === 0) {
      process.stderr.write(
        '[run-state] no conversation log captured (claude-state/projects empty -- agent likely crashed before first message)\n',
      );
      return;
    }
    cpSync(paths.claudeProjectsSrc, paths.claudeLogsDir, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[run-state] conversation-log capture failed: ${message}\n`);
  }
}
