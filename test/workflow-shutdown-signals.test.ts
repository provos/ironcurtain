import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWorkflowShutdownSignals } from '../src/workflow/shutdown-signals.js';

afterEach(() => {
  vi.useRealTimers();
});

function installedHandler(signal: NodeJS.Signals, before: ReadonlySet<NodeJS.SignalsListener>): NodeJS.SignalsListener {
  const handler = process.listeners(signal).find((listener) => !before.has(listener));
  if (!handler) throw new Error(`No ${signal} handler was installed`);
  return handler as NodeJS.SignalsListener;
}

describe('workflow shutdown signals', () => {
  it('aborts gracefully, escalates a second signal, and removes exact wrappers', () => {
    const before = new Set(process.listeners('SIGTERM'));
    const controller = new AbortController();
    const forceExit = vi.fn();
    const onFirstSignal = vi.fn();
    const uninstall = installWorkflowShutdownSignals(controller, { forceExit, onFirstSignal });
    const handler = installedHandler('SIGTERM', before);

    handler('SIGTERM');
    expect(controller.signal.aborted).toBe(true);
    expect(onFirstSignal).toHaveBeenCalledWith('SIGTERM');
    expect(forceExit).not.toHaveBeenCalled();

    handler('SIGTERM');
    expect(forceExit).toHaveBeenCalledWith(143);

    uninstall();
    expect(new Set(process.listeners('SIGTERM'))).toEqual(before);
  });

  it('forces exit when graceful teardown exceeds its deadline', async () => {
    vi.useFakeTimers();
    const before = new Set(process.listeners('SIGHUP'));
    const forceExit = vi.fn();
    const uninstall = installWorkflowShutdownSignals(new AbortController(), {
      forceExit,
      forceExitAfterMs: 25,
    });

    installedHandler('SIGHUP', before)('SIGHUP');
    await vi.advanceTimersByTimeAsync(25);
    expect(forceExit).toHaveBeenCalledWith(129);

    uninstall();
  });
});
