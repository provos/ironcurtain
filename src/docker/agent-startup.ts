/** Synchronize host execs with the Linux agent entrypoint's UID remapping. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ContainerRuntime } from './types.js';
import { boundedLogTail } from './bounded-log-tail.js';

// Bind the signal to this invocation of container init, not just the writable
// layer. Both /proc values change independently of snapshot/restored files.
// Strip through the last ')' before splitting: the process name can contain
// spaces and parentheses. Field 22 (starttime) is field 20 of the remainder.
const STARTUP_IDENTITY = `
startup_identity() (
  IFS= read -r boot < /proc/sys/kernel/random/boot_id || exit
  IFS= read -r stat < /proc/1/stat || exit
  stat=\${stat##*) }
  IFS=' '
  set -f
  set -- $stat
  [ "$#" -ge 20 ] || exit 1
  shift 19
  printf '%s:%s\\n' "$boot" "$1"
)
`;

const READY_PROBE = `${STARTUP_IDENTITY}
[ ! -L "$1" ] && [ -f "$1" ] || exit 1
IFS= read -r observed < "$1" || exit
expected=$(startup_identity) || exit
[ "$observed" = "$expected" ]
`;

interface StartupWaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/**
 * The image entrypoint execs CMD only after remapping the account, fixing its
 * home ownership, and configuring the adapter. Wrap that handoff, not the
 * entrypoint itself. A fresh pathname avoids stale readiness in snapshots.
 * This is an ordering signal inside an untrusted container, not attestation.
 */
export function prepareDockerAgentStartup(
  command: readonly string[],
  needsUidRemap: boolean,
): {
  readonly command: readonly string[];
  waitUntilReady(
    runtime: Pick<ContainerRuntime, 'exec' | 'isRunning' | 'readContainerLogTail'>,
    containerId: string,
    options?: StartupWaitOptions,
  ): Promise<void>;
} {
  const readyPath = `/tmp/ironcurtain-agent-ready-${randomUUID()}`;
  return {
    command: needsUidRemap
      ? [
          '/bin/sh',
          '-c',
          `${STARTUP_IDENTITY}
rm -f -- "$1" || exit
(umask 077; set -C; startup_identity > "$1") || exit
shift
exec "$@"`,
          'ironcurtain-agent-startup',
          readyPath,
          ...command,
        ]
      : command,
    async waitUntilReady(runtime, containerId, options = {}) {
      if (!needsUidRemap) return;
      const timeoutMs = options.timeoutMs ?? 90_000;
      const deadline = Date.now() + timeoutMs;
      let pollIntervalMs = options.pollIntervalMs ?? 250;
      for (;;) {
        // Numeric root does not depend on the passwd entry being rewritten.
        // Ordinary agent execs remain codespace and begin only after this gate.
        const result = await runtime.exec(
          containerId,
          ['/bin/sh', '-c', READY_PROBE, 'ironcurtain-agent-startup', readyPath],
          5_000,
          '0:0',
        );
        if (result.exitCode === 0) return;
        let running: boolean | undefined;
        try {
          running = await runtime.isRunning(containerId, { throwOnError: true });
        } catch {
          // An unavailable inspect is not evidence that the container exited.
        }
        if (running === false || Date.now() >= deadline) {
          let logs = '(container log unavailable)';
          try {
            const tail = await runtime.readContainerLogTail?.(containerId);
            if (tail !== undefined) logs = boundedLogTail(tail, 2048) || '(container log is empty)';
          } catch {
            // Diagnostic failure must not hide the startup failure.
          }
          throw new Error(
            `Docker agent entrypoint ${running === false ? 'exited before becoming ready' : `did not become ready within ${timeoutMs}ms`}; ` +
              `UID remapping and adapter initialization must finish before agent execs.\n${logs}`,
          );
        }
        await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
        if (options.pollIntervalMs === undefined) pollIntervalMs = Math.min(pollIntervalMs * 2, 2_000);
      }
    },
  };
}
