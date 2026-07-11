import { constants } from 'node:os';

const WORKFLOW_FORCE_EXIT_MS = 30_000;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export interface WorkflowShutdownSignalOptions {
  readonly forceExitAfterMs?: number;
  readonly onFirstSignal?: (signal: NodeJS.Signals) => void;
  readonly forceExit?: (exitCode: number) => void;
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + constants.signals[signal];
}

/** Installs bounded graceful shutdown and returns an exact unregister thunk. */
export function installWorkflowShutdownSignals(
  controller: AbortController,
  options: WorkflowShutdownSignalOptions = {},
): () => void {
  const forceExit = options.forceExit ?? ((exitCode: number) => process.exit(exitCode));
  let firstSignal: NodeJS.Signals | undefined;
  let forceExitTimer: NodeJS.Timeout | undefined;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (firstSignal) {
      if (forceExitTimer) clearTimeout(forceExitTimer);
      forceExit(signalExitCode(signal));
      return;
    }

    firstSignal = signal;
    options.onFirstSignal?.(signal);
    controller.abort();
    forceExitTimer = setTimeout(
      () => forceExit(signalExitCode(signal)),
      options.forceExitAfterMs ?? WORKFLOW_FORCE_EXIT_MS,
    );
    forceExitTimer.unref();
  };

  // Keep named wrappers so teardown removes precisely what was installed.
  const handlers: Record<(typeof SIGNALS)[number], () => void> = {
    SIGINT: () => handleSignal('SIGINT'),
    SIGTERM: () => handleSignal('SIGTERM'),
    SIGHUP: () => handleSignal('SIGHUP'),
  };
  for (const signal of SIGNALS) process.on(signal, handlers[signal]);

  return () => {
    if (forceExitTimer) clearTimeout(forceExitTimer);
    for (const signal of SIGNALS) process.off(signal, handlers[signal]);
  };
}
