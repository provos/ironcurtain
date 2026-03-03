/**
 * MuxApp -- top-level orchestrator for the terminal multiplexer.
 *
 * Creates and owns all child components. Handles MuxAction dispatch,
 * tab lifecycle, resize events, trusted input flow, and cleanup.
 */

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

import { createPtyBridge } from './pty-bridge.js';
import { createMuxInputHandler, type MuxInputHandler } from './mux-input-handler.js';
import { createMuxEscalationManager, type MuxEscalationManager } from './mux-escalation-manager.js';
import { createMuxRenderer, type MuxRenderer } from './mux-renderer.js';
import { writeTrustedUserContext } from './trusted-input.js';
import type { MuxTab, MuxAction } from './types.js';
import { validateWorkspacePath } from '../session/workspace-validation.js';
import * as logger from '../logger.js';

export interface MuxApp {
  /** Starts the multiplexer (enters fullscreen, spawns initial session). */
  start(): Promise<void>;
  /** Graceful shutdown: kills all child processes, restores terminal. */
  shutdown(): Promise<void>;
}

export interface MuxAppOptions {
  /** Agent to use for PTY sessions. Defaults to 'claude-code'. */
  readonly agent?: string;
  /** Whether to auto-spawn an initial session. Default: true. */
  readonly autoSpawn?: boolean;
  /** Protected paths for workspace validation. */
  readonly protectedPaths?: string[];
}

/**
 * Creates and returns a MuxApp.
 */
export function createMuxApp(options: MuxAppOptions): MuxApp {
  const agent = options.agent ?? 'claude-code';
  const autoSpawn = options.autoSpawn ?? true;
  const protectedPaths = options.protectedPaths ?? [];

  const tabs: MuxTab[] = [];
  let activeTabIndex = 0;
  let nextTabNumber = 1;
  let running = false;

  // Mouse event constants
  const MOUSE_WHEEL_UP = 'MOUSE_WHEEL_UP';
  const MOUSE_WHEEL_DOWN = 'MOUSE_WHEEL_DOWN';
  const SCROLL_LINES = 3;

  // Components (initialized in start())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let term: any;
  let inputHandler!: MuxInputHandler;
  let escalationManager!: MuxEscalationManager;
  let renderer!: MuxRenderer;

  function getActiveTab(): MuxTab | undefined {
    return tabs[activeTabIndex];
  }

  function resolveIroncurtainBin(): { bin: string; prefixArgs: string[] } {
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

  async function spawnSession(workspacePath?: string): Promise<MuxTab> {
    const { columns } = process.stdout;
    const ptyRows = renderer.layout.ptyViewportRows;
    const ptyCols = columns || 80;

    const { bin, prefixArgs } = resolveIroncurtainBin();
    const bridge = await createPtyBridge({
      cols: ptyCols,
      rows: ptyRows,
      ironcurtainBin: bin,
      prefixArgs,
      agent,
      workspacePath,
    });

    const tab: MuxTab = {
      number: nextTabNumber++,
      bridge,
      label: agent,
      status: 'running',
      escalationAvailable: false,
      scrollOffset: null,
    };

    tabs.push(tab);

    // Wire bridge events
    bridge.onOutput(() => {
      // Snap back to live when new output arrives
      if (tab.scrollOffset !== null) {
        tab.scrollOffset = null;
      }
      if (getActiveTab() === tab) {
        renderer.scheduleRedraw();
      }
    });

    bridge.onExit((exitCode: number) => {
      tab.status = 'exited';
      tab.exitCode = exitCode;

      // Skip UI effects if the mux is shutting down or the tab was already removed
      if (!running || !tabs.includes(tab)) return;

      if (bridge.sessionId) {
        escalationManager.removeSession(bridge.sessionId);
      }

      renderer.redrawTabBar();

      if (getActiveTab() === tab) {
        showMessage(`Session #${tab.number} exited with code ${exitCode}`);
      }

      process.stderr.write('\x07');
    });

    bridge.onSessionDiscovered((registration) => {
      if (registration && tab.status === 'running') {
        tab.escalationAvailable = true;
        escalationManager.addSession(registration);
        tab.label = registration.label;
        renderer.redrawTabBar();
      } else if (!registration) {
        logger.warn(`Could not discover session registration for tab #${tab.number}`);
        tab.escalationAvailable = false;
      }
    });

    return tab;
  }

  function switchTab(index: number): void {
    if (index < 0 || index >= tabs.length) return;
    activeTabIndex = index;
    renderer.fullRedraw();
  }

  function closeTab(tabNumber: number): void {
    const index = tabs.findIndex((t) => t.number === tabNumber);
    if (index === -1) {
      showMessage(`No tab #${tabNumber}`);
      return;
    }

    const tab = tabs[index];
    tab.bridge.kill();

    if (tab.bridge.sessionId) {
      escalationManager.removeSession(tab.bridge.sessionId);
    }

    tabs.splice(index, 1);

    if (tabs.length === 0) {
      doShutdown();
      return;
    }

    if (activeTabIndex >= tabs.length) {
      activeTabIndex = tabs.length - 1;
    }
    renderer.fullRedraw();
  }

  /** Adjusts scroll offset by delta lines (negative = up, positive = down). */
  function adjustScroll(tab: MuxTab, delta: number): void {
    const baseY = tab.bridge.terminal.buffer.active.baseY;
    if (baseY === 0) return; // no scrollback available
    const current = tab.scrollOffset ?? baseY;
    const newOffset = current + delta;
    if (newOffset >= baseY) {
      tab.scrollOffset = null; // snap to live
    } else {
      tab.scrollOffset = Math.max(0, newOffset);
    }
  }

  function showMessage(message: string): void {
    logger.info(message);
    renderer.showMessage(message);
  }

  async function handleAction(action: MuxAction): Promise<void> {
    switch (action.kind) {
      case 'none':
        break;

      case 'write-pty': {
        const active = getActiveTab();
        if (active && active.bridge.alive) {
          active.bridge.write(action.data);
        }
        break;
      }

      case 'enter-command-mode':
      case 'enter-pty-mode':
        renderer.fullRedraw();
        break;

      case 'command':
        handleCommand(action.command, action.args);
        break;

      case 'trusted-input': {
        const active = getActiveTab();
        if (active && active.bridge.alive) {
          if (active.bridge.escalationDir) {
            writeTrustedUserContext(active.bridge.escalationDir, action.text);
          } else {
            logger.warn(`Tab #${active.number}: escalation dir not yet available, skipping user-context write`);
            process.stderr.write('\x07');
          }
          // Write text first, then \r separately after a short delay so
          // Claude Code's Ink UI processes them as distinct input events.
          // A single write of "text\r" arrives as one chunk and Ink may
          // not trigger Enter when \r is bundled with preceding text.
          active.bridge.write(action.text);
          const bridge = active.bridge;
          setTimeout(() => {
            if (bridge.alive) bridge.write('\r');
          }, 50);
        }
        // Return to PTY mode after sending trusted input
        inputHandler.handleKey('CTRL_A');
        renderer.fullRedraw();
        break;
      }

      case 'redraw-input':
        renderer.redrawCommandArea();
        break;

      case 'enter-picker-mode':
        renderer.fullRedraw();
        break;

      case 'picker-spawn': {
        let validatedPath: string | undefined;
        if (action.workspacePath) {
          try {
            validatedPath = validateWorkspacePath(action.workspacePath, protectedPaths);
          } catch (err) {
            inputHandler.enterBrowseWithError(action.workspacePath, err instanceof Error ? err.message : String(err));
            renderer.fullRedraw();
            break;
          }
        }
        const tab = await spawnSession(validatedPath);
        activeTabIndex = tabs.length - 1;
        const suffix = validatedPath ? ` in ${validatedPath}` : '';
        showMessage(`Spawned session #${tab.number}${suffix}`);
        inputHandler.exitPickerMode();
        renderer.fullRedraw();
        break;
      }

      case 'picker-cancel':
        renderer.fullRedraw();
        break;

      case 'redraw-picker':
        renderer.redrawCommandArea();
        break;

      case 'scroll-up':
      case 'scroll-down': {
        const active = getActiveTab();
        if (!active) break;
        const delta = action.kind === 'scroll-up' ? -action.amount : action.amount;
        adjustScroll(active, delta);
        renderer.scheduleRedraw();
        break;
      }

      case 'quit':
        doShutdown();
        break;
    }
  }

  function handleCommand(command: string, args: string[]): void {
    switch (command) {
      case 'approve':
      case 'deny': {
        const decision = command === 'approve' ? 'approved' : 'denied';
        const arg = args[0];
        if (!arg) {
          showMessage(`Usage: /${command} <number> or /${command} all`);
          break;
        }
        let message: string;
        if (arg === 'all') {
          message = escalationManager.resolveAll(decision);
        } else {
          const num = parseInt(arg, 10);
          if (isNaN(num)) {
            showMessage('Invalid escalation number');
            break;
          }
          message = escalationManager.resolve(num, decision);
        }
        showMessage(message);
        renderer.redrawTabBar();
        renderer.redrawCommandArea();
        break;
      }

      case 'new': {
        inputHandler.enterPickerMode();
        renderer.fullRedraw();
        break;
      }

      case 'tab': {
        const num = parseInt(args[0], 10);
        if (isNaN(num)) {
          showMessage('Usage: /tab <number>');
          break;
        }
        const index = tabs.findIndex((t) => t.number === num);
        if (index === -1) {
          showMessage(`No tab #${num}`);
          break;
        }
        switchTab(index);
        break;
      }

      case 'close': {
        const num = args[0] ? parseInt(args[0], 10) : getActiveTab()?.number;
        if (num === undefined || isNaN(num)) {
          showMessage('Usage: /close [number]');
          break;
        }
        closeTab(num);
        break;
      }

      case 'sessions': {
        const sessionInfo = [...escalationManager.state.sessions.values()]
          .map((s) => `  [${s.displayNumber}] ${s.registration.sessionId.substring(0, 8)} ${s.registration.label}`)
          .join('\n');
        showMessage(sessionInfo || 'No active sessions');
        break;
      }

      case 'quit':
      case 'q':
        doShutdown();
        break;

      default:
        showMessage(`Unknown command: /${command}`);
    }
  }

  function doShutdown(): void {
    if (!running) return;
    running = false;

    for (const tab of tabs) {
      if (tab.bridge.alive) {
        tab.bridge.kill();
      }
    }

    escalationManager.stop();

    if (term) {
      term.grabInput(false);
      term.hideCursor(false);
      term.fullscreen(false);
      term.styleReset();
    }

    renderer.destroy();
  }

  return {
    async start(): Promise<void> {
      running = true;

      const terminalKit = await import('terminal-kit');
      // CJS interop: terminal lives on the default export object
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      term = terminalKit.default.terminal ?? (terminalKit as any).terminal;

      term.fullscreen(true);
      term.hideCursor(true);
      term.grabInput({ mouse: 'button' });

      inputHandler = createMuxInputHandler({ initialMode: autoSpawn ? 'pty' : 'command' });
      escalationManager = createMuxEscalationManager();

      const { columns, rows } = process.stdout;
      const cols = columns || 80;
      const totalRows = rows || 24;

      renderer = createMuxRenderer(term, cols, totalRows, {
        getActiveTab,
        getTabs: () => tabs,
        getActiveTabIndex: () => activeTabIndex,
        getMode: () => inputHandler.mode,
        getInputBuffer: () => inputHandler.inputBuffer,
        getCursorPos: () => inputHandler.cursorPos,
        getEscalationState: () => escalationManager.state,
        getPendingCount: () => escalationManager.pendingCount,
        getPickerState: () => inputHandler.pickerState,
        getScrollOffset: () => {
          const active = getActiveTab();
          return active?.scrollOffset ?? null;
        },
      });

      term.on('key', (key: string) => {
        if (!running) return;
        const action = inputHandler.handleKey(key);
        void handleAction(action);
      });

      // Mouse events come through a separate 'mouse' emitter, not 'key'
      term.on('mouse', (name: string) => {
        if (!running) return;
        if (name === MOUSE_WHEEL_UP) {
          void handleAction({ kind: 'scroll-up', amount: SCROLL_LINES });
        } else if (name === MOUSE_WHEEL_DOWN) {
          void handleAction({ kind: 'scroll-down', amount: SCROLL_LINES });
        }
      });

      process.stdout.on('resize', () => {
        const { columns: newCols, rows: newRows } = process.stdout;
        if (!newCols || !newRows) return;

        renderer.resize(newCols, newRows);

        const layout = renderer.layout;
        for (const tab of tabs) {
          if (tab.bridge.alive) {
            tab.bridge.resize(newCols, layout.ptyViewportRows);
          }
        }

        renderer.fullRedraw();
      });

      escalationManager.onChange(() => {
        renderer.redrawTabBar();
        renderer.redrawCommandArea();
      });

      escalationManager.startRegistryPolling();

      // Back-fill bridge registrations that timed out during initial
      // discovery. When registry polling finds a session whose PID
      // matches a bridge that still has no registration, push it in.
      escalationManager.onSessionDiscovered((reg) => {
        for (const tab of tabs) {
          if (tab.bridge.pid === reg.pid && !tab.bridge.sessionId) {
            tab.bridge.updateRegistration(reg);
            tab.escalationAvailable = true;
            tab.label = reg.label;
            escalationManager.claimSession(reg.sessionId);
            renderer.redrawTabBar();
            break;
          }
        }
      });

      const handleSignal = (): void => {
        doShutdown();
      };
      process.on('SIGINT', handleSignal);
      process.on('SIGTERM', handleSignal);
      process.on('SIGHUP', handleSignal);

      process.on('exit', () => {
        if (term) {
          term.grabInput(false);
        }
      });

      if (autoSpawn) {
        await spawnSession();
      }

      renderer.fullRedraw();

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!running) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async shutdown(): Promise<void> {
      doShutdown();
    },
  };
}
