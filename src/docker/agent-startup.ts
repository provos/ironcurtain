/** Synchronize host execs with the Linux agent entrypoint's UID remapping. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ContainerRuntime } from './types.js';

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
          '(umask 077; set -C; : > "$1") || exit; shift; exec "$@"',
          'ironcurtain-agent-startup',
          readyPath,
          ...command,
        ]
      : command,
    async waitUntilReady(runtime, containerId, options = {}) {
      if (!needsUidRemap) return;
      const timeoutMs = options.timeoutMs ?? 90_000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // Numeric root does not depend on the passwd entry being rewritten.
        // Ordinary agent execs remain codespace and begin only after this gate.
        const result = await runtime.exec(
          containerId,
          ['/bin/sh', '-c', 'test -f "$1"', 'ironcurtain-agent-startup', readyPath],
          5_000,
          '0:0',
        );
        if (result.exitCode === 0) return;
        const running = await runtime.isRunning(containerId);
        if (!running || Date.now() >= deadline) {
          let logs = '(container log unavailable)';
          try {
            logs =
              (await runtime.readContainerLogTail?.(containerId))?.replace(/[^\P{Cc}\n\t]/gu, '').slice(-2048) || logs;
          } catch {
            // Diagnostic failure must not hide the startup failure.
          }
          throw new Error(
            `Docker agent entrypoint ${running ? `did not become ready within ${timeoutMs}ms` : 'exited before becoming ready'}; ` +
              `UID remapping and adapter initialization must finish before agent execs.\n${logs}`,
          );
        }
        await delay(options.pollIntervalMs ?? 250);
      }
    },
  };
}
