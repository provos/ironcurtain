# Design: Terminal Multiplexer (`ironcurtain mux`)

**Status:** Proposed
**Date:** 2026-03-02
**Author:** IronCurtain Engineering

## 1. Problem Statement

Docker Agent Mode's PTY support (`ironcurtain start --pty`) provides a native interactive experience where the user's terminal is attached directly to Claude Code inside a container. However, the current architecture has three significant limitations:

1. **Two-terminal requirement.** The user needs one terminal for each PTY session and a separate terminal running `ironcurtain escalation-listener` to handle policy escalations. Managing multiple sessions requires multiple terminal windows -- a poor user experience.

2. **No trusted input path in PTY mode.** The auto-approver (`src/trusted-process/auto-approver.ts`) reads `user-context.json` from the escalation directory to match escalated tool calls against the user's stated intent. In standard mode, the session writes this file at the start of each `sendMessage()` call. In PTY mode, user input goes directly into the container PTY via the socket bridge -- once inside the sandbox, it cannot be distinguished from text injected by a compromised sandbox. The auto-approver is therefore disabled for PTY mode (no `user-context.json` is written), and every escalation requires manual approval.

3. **No session management.** Each PTY session runs in its own terminal process. There is no unified view of all sessions, no way to switch between them, and no way to spawn new sessions from a single interface.

### What we want

A single terminal command (`ironcurtain mux`) that:

- Displays one or more PTY sessions in a tabbed full-screen interface
- Handles all escalation approvals in-band, without a separate terminal
- Provides a **trusted input path** for user messages that enables the auto-approver in PTY mode
- Replaces `ironcurtain escalation-listener` as a strict superset

## 2. Design Overview

The terminal multiplexer is a full-screen terminal application that combines three capabilities:

1. **PTY session rendering** -- Spawns `ironcurtain start --pty` as child processes via `node-pty`, captures their output through `@xterm/headless` (headless xterm emulation), and renders the parsed terminal state into `terminal-kit` ScreenBuffers for display.

2. **Escalation handling** -- Reuses the existing `EscalationWatcher` and `ListenerState` modules to poll escalation directories and present pending escalations for approval/denial.

3. **Trusted user input** -- Captures user text in a host-side command mode, writes it to `user-context.json` in the active session's escalation directory (with a `source: "mux-trusted-input"` field), and then forwards it to the PTY. The auto-approver can read this trusted context.

### Tech Stack

| Layer | Library | Version | Role |
|-------|---------|---------|------|
| Layout engine | `terminal-kit` | 3.1.2 | Fullscreen document model, ScreenBuffer with delta rendering, key/mouse handling |
| PTY state parser | `@xterm/headless` | 6.0.0 | Headless xterm emulation -- parses ANSI escape sequences, maintains virtual terminal buffer |
| PTY spawning | `node-pty` | 1.1.0 | Spawn child processes with pseudo-terminals |

### Component Diagram

```
                 ┌───────────────────────────────────────────────────────┐
                 │                  ironcurtain mux                      │
                 │                                                       │
                 │  ┌─────────────────────────────────────────────────┐  │
                 │  │              MuxApp (orchestrator)              │  │
                 │  │                                                 │  │
                 │  │  ┌────────────┐  ┌────────────┐  ┌──────────┐  │  │
                 │  │  │ PtyBridge  │  │ PtyBridge  │  │ PtyBridge│  │  │
                 │  │  │ (tab #1)   │  │ (tab #2)   │  │ (tab #3) │  │  │
                 │  │  └─────┬──────┘  └─────┬──────┘  └────┬─────┘  │  │
                 │  │        │               │               │        │  │
                 │  │  ┌─────┴──────┐  ┌─────┴──────┐  ┌────┴─────┐  │  │
                 │  │  │ node-pty   │  │ node-pty   │  │ node-pty │  │  │
                 │  │  │ child proc │  │ child proc │  │ child    │  │  │
                 │  │  └─────┬──────┘  └─────┬──────┘  └────┬─────┘  │  │
                 │  │        │               │               │        │  │
                 │  │  ┌─────┴──────┐  ┌─────┴──────┐  ┌────┴─────┐  │  │
                 │  │  │ @xterm/    │  │ @xterm/    │  │ @xterm/  │  │  │
                 │  │  │ headless   │  │ headless   │  │ headless │  │  │
                 │  │  └────────────┘  └────────────┘  └──────────┘  │  │
                 │  │                                                 │  │
                 │  │  ┌────────────────────────────────────────────┐ │  │
                 │  │  │          MuxRenderer                      │ │  │
                 │  │  │  (terminal-kit ScreenBuffer rendering)    │ │  │
                 │  │  └────────────────────────────────────────────┘ │  │
                 │  │                                                 │  │
                 │  │  ┌────────────────────────────────────────────┐ │  │
                 │  │  │          MuxEscalationManager              │ │  │
                 │  │  │  (reuses EscalationWatcher + ListenerState)│ │  │
                 │  │  └────────────────────────────────────────────┘ │  │
                 │  │                                                 │  │
                 │  │  ┌────────────────────────────────────────────┐ │  │
                 │  │  │          MuxInputHandler                   │ │  │
                 │  │  │  (key routing + command mode + trusted     │ │  │
                 │  │  │   input capture)                           │ │  │
                 │  │  └────────────────────────────────────────────┘ │  │
                 │  └─────────────────────────────────────────────────┘  │
                 │                                                       │
                 │            each node-pty child runs:                  │
                 │     ironcurtain start --pty --agent claude-code       │
                 │                          │                            │
                 └──────────────────────────┼────────────────────────────┘
                                            │
                                            ▼
                              Docker container (per session)
                              Claude Code + MCP proxy + MITM proxy
```

## 3. Key Design Decisions

### 3.1 Spawn `ironcurtain start --pty` as child processes, not raw Docker containers

The multiplexer spawns the existing `ironcurtain start --pty` command as a child process via `node-pty`. This reuses all existing Docker infrastructure setup (proxy spawning, MITM proxy, container lifecycle, registration files, cleanup). The alternative -- having the mux directly create Docker containers -- would duplicate hundreds of lines of infrastructure code from `pty-session.ts` and `docker-infrastructure.ts`.

The child process thinks it has a real PTY (provided by `node-pty`). The mux reads its output, feeds it through `@xterm/headless` for ANSI parsing, and renders the result. Input from the user is written to the child's PTY in PTY mode or captured host-side in command mode.

### 3.2 `@xterm/headless` for ANSI parsing, not manual parsing

Claude Code uses rich terminal output: colors, cursor movement, alternate screen buffer, scrolling regions, etc. Writing a correct ANSI parser is impractical. `@xterm/headless` is the headless version of xterm.js -- the same terminal emulator used by VS Code's integrated terminal. It handles all escape sequences correctly and maintains a proper terminal buffer with scrollback.

### 3.3 `terminal-kit` ScreenBuffer for rendering, not raw ANSI output

The mux needs to compose multiple UI elements (tab bar, PTY viewport, escalation panel, input line) into a single screen. `terminal-kit`'s ScreenBuffer provides cell-level manipulation and delta-optimized rendering (only redraws changed cells). This is critical for performance -- re-rendering a full 80x24 terminal on every PTY output byte would cause visible flicker.

We avoid `terminal-kit`'s `Layout` widget because it is undocumented (marked TODOC in the library). Instead, we use ScreenBuffer directly with manual row/column calculations for each UI region.

### 3.4 Two input modes with `Ctrl-A` as the command character

Following the precedent of `screen` and `tmux`, `Ctrl-A` toggles between PTY mode (keystrokes go to the active session) and command mode (keystrokes go to the mux's input line). This is a familiar idiom for terminal users. `Ctrl-A Ctrl-A` sends a literal `Ctrl-A` to the PTY for users who need it (e.g., readline home).

### 3.5 Trusted input via command mode text, not a separate channel

When the user types non-command text in command mode and presses Enter, the text is captured host-side (never touches the sandbox), written to `user-context.json`, and then forwarded to the PTY's stdin. This dual-write approach enables the auto-approver without requiring a new IPC mechanism. The `source: "mux-trusted-input"` field in the JSON distinguishes trusted input from session-written context.

### 3.6 Escalation display as notification badge + expandable panel

Minimal disruption: in PTY mode, pending escalations are shown as a count badge in the tab bar (`[!3]`). Entering command mode expands a panel above the input line showing escalation details. This keeps the PTY viewport as large as possible during normal operation.

### 3.7 Single-instance enforcement shared with escalation-listener

The mux acquires the same lock file (`~/.ironcurtain/escalation-listener.lock`) as the current escalation listener. Only one of `ironcurtain mux` or `ironcurtain escalation-listener` can run at a time. This prevents conflicting escalation resolution.

### 3.8 Graceful degradation on child process crashes

If a PTY session's child process exits unexpectedly, the mux marks that tab as "[exited]" and preserves its last rendered state. The user can close the tab with `/close N` or spawn a new session with `/new`. The mux itself remains running.

### 3.9 Double-PTY layering is intentional and safe

When the mux spawns `ironcurtain start --pty` via `node-pty`, two PTY layers exist:

```
Real terminal (user's shell)
    ↕ terminal-kit manages this
Mux process (ironcurtain mux)
    ↕ node-pty master/slave pair
Child process (ironcurtain start --pty)
    ↕ Docker socket bridge
Container PTY (Claude Code inside Docker)
```

The child's `pty-session.ts` calls `stdin.setRawMode(true)` on its stdin (the node-pty slave) and reads from it. This is correct behavior -- the child thinks it has a real terminal. The mux writes to the node-pty master, and the child reads from the node-pty slave. These do not conflict.

**Key implications:**

1. **Resize propagation works naturally.** The mux calls `node-pty.resize()` on the master → SIGWINCH is delivered to the child → the child's existing resize handler calls `docker exec resize-pty.sh` → the container PTY is resized. No extra work needed.

2. **The child's `Ctrl-\` handler (0x1c) intercepts emergency exit.** The mux must NOT also handle `Ctrl-\`, as it would never reach the child. The mux's emergency exit is `Ctrl-A q` instead (see Section 10.3).

3. **The child's raw mode on the slave is transparent to the mux.** The mux only interacts with the master side of the node-pty pair. The slave's raw mode affects the child's stdin behavior, not the mux's.

### 3.10 `node-pty` is a native dependency -- optional for non-mux users

`node-pty` is a C++ native module requiring platform-specific compilation (`node-gyp`, C++ toolchain). The project currently has zero native dependencies. Adding it globally would burden all users with build toolchain requirements.

**Mitigation:** `node-pty` is listed as an `optionalDependency` in `package.json`. The `ironcurtain mux` command checks for its availability at startup and prints a clear error if it's missing:

```typescript
// In mux-command.ts:
let nodePty: typeof import('node-pty');
try {
  nodePty = await import('node-pty');
} catch {
  process.stderr.write(
    'Error: ironcurtain mux requires the node-pty package.\n' +
    'Install it with: npm install node-pty\n'
  );
  process.exit(1);
}
```

All other IronCurtain commands work without `node-pty` installed. `@xterm/headless` and `terminal-kit` are pure JS and can be regular dependencies.

## 4. Interface Definitions

### 4.1 MuxApp (Orchestrator)

```typescript
// src/mux/mux-app.ts

import type { IronCurtainConfig } from '../config/types.js';

/**
 * Top-level orchestrator for the terminal multiplexer.
 * Manages the lifecycle of all child components.
 */
export interface MuxApp {
  /** Starts the multiplexer (enters fullscreen, spawns initial session). */
  start(): Promise<void>;
  /** Graceful shutdown: kills all child processes, restores terminal. */
  shutdown(): Promise<void>;
}

export interface MuxAppOptions {
  /** Base IronCurtain config (loaded from environment + config file). */
  readonly config: IronCurtainConfig;
  /** Agent to use for PTY sessions. Defaults to 'claude-code'. */
  readonly agent?: string;
  /** Whether to auto-spawn an initial session. Default: true. */
  readonly autoSpawn?: boolean;
}

export function createMuxApp(options: MuxAppOptions): MuxApp;
```

### 4.2 PtyBridge (Core Novel Component)

```typescript
// src/mux/pty-bridge.ts

import type { Terminal as HeadlessTerminal } from '@xterm/headless';

/**
 * Bridges a node-pty child process to a headless xterm terminal.
 *
 * Data flow:
 *   node-pty child → raw bytes → @xterm/headless Terminal.write()
 *   @xterm/headless buffer → readBuffer() → MuxRenderer
 *
 * Each PtyBridge instance owns:
 * - One node-pty child process (the `ironcurtain start --pty` invocation)
 * - One @xterm/headless Terminal (the virtual terminal buffer)
 * - The session's escalation directory path (for trusted input writes)
 */
export interface PtyBridge {
  /** The headless terminal instance for reading buffer state. */
  readonly terminal: HeadlessTerminal;

  /** The session ID (extracted from child process registration). */
  readonly sessionId: string | undefined;

  /** The escalation directory path for this session. */
  readonly escalationDir: string | undefined;

  /** Whether the child process is still running. */
  readonly alive: boolean;

  /** The child process exit code, if exited. */
  readonly exitCode: number | undefined;

  /**
   * Writes raw bytes to the child process's PTY stdin.
   * Used in PTY mode to forward keystrokes.
   */
  write(data: string): void;

  /**
   * Resizes the child PTY and the headless terminal.
   * Called on SIGWINCH and on tab switch.
   */
  resize(cols: number, rows: number): void;

  /**
   * Kills the child process and cleans up resources.
   */
  kill(): void;

  /**
   * Registers a callback invoked when new output arrives.
   * The MuxRenderer uses this to schedule redraws.
   */
  onOutput(callback: () => void): void;

  /**
   * Registers a callback invoked when the child process exits.
   */
  onExit(callback: (exitCode: number) => void): void;

  /**
   * Registers a callback invoked when the child's session registration
   * is discovered (sessionId and escalationDir become available).
   *
   * The PtyBridge polls the PTY registry after spawning the child,
   * matching on the child's PID. Once found, sessionId and escalationDir
   * are populated and this callback fires. The MuxApp uses this to
   * start escalation watching and enable trusted input for the session.
   *
   * If discovery times out (10s), the callback fires with null.
   */
  onSessionDiscovered(callback: (registration: import('../docker/pty-types.js').PtySessionRegistration | null) => void): void;
}

export interface PtyBridgeOptions {
  /** Columns for the initial PTY size. */
  readonly cols: number;
  /** Rows for the initial PTY size. */
  readonly rows: number;
  /** The ironcurtain binary path (resolved from process.argv[0] or 'ironcurtain'). */
  readonly ironcurtainBin: string;
  /** Agent to pass to --agent flag. */
  readonly agent: string;
}

/**
 * Spawns a new `ironcurtain start --pty` child process via node-pty
 * and wires it to a headless xterm terminal.
 */
export function createPtyBridge(options: PtyBridgeOptions): PtyBridge;
```

### 4.3 MuxRenderer

```typescript
// src/mux/mux-renderer.ts

import type { ScreenBufferHD } from 'terminal-kit';

/**
 * Composes all UI regions into a terminal-kit ScreenBuffer and draws
 * to the real terminal with delta optimization.
 *
 * UI regions (top to bottom):
 *   [tab bar]          1 row
 *   [pty viewport]     variable height (fills remaining space)
 *   [escalation panel] 0 or N rows (only in command mode with pending escalations)
 *   [hint bar]         1 row
 *   [input line]       0 or 1 row (only in command mode)
 */
export interface MuxRenderer {
  /** Full redraw of all regions. Called on resize and mode switch. */
  fullRedraw(): void;

  /** Incremental redraw of only the PTY viewport. Called on PTY output. */
  redrawPty(): void;

  /** Redraws just the tab bar (e.g., when escalation count changes). */
  redrawTabBar(): void;

  /** Redraws the escalation panel and input line (command mode). */
  redrawCommandArea(): void;

  /** Handles terminal resize. */
  resize(cols: number, rows: number): void;

  /** Cleans up terminal-kit resources and restores screen. */
  destroy(): void;
}

/**
 * A single cell from the @xterm/headless buffer, translated to
 * terminal-kit ScreenBuffer attributes.
 *
 * Color values use terminal-kit's ScreenBufferHD format:
 * - 'default': terminal default color
 * - number: palette index (0-255)
 * - { r, g, b }: 24-bit truecolor
 */
export type TermkitColor = number | { r: number; g: number; b: number } | 'default';

export interface TranslatedCell {
  readonly char: string;
  readonly width: number;        // 1 for normal, 2 for wide (CJK/emoji)
  readonly fg: TermkitColor;
  readonly bg: TermkitColor;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly dim: boolean;
  readonly inverse: boolean;
  readonly strikethrough: boolean;
}

/**
 * Reads the active PtyBridge's headless terminal buffer and translates
 * each cell into terminal-kit ScreenBuffer attributes.
 *
 * This is the core bridge function. It iterates over the visible rows
 * of the @xterm/headless buffer, extracts each cell's character and
 * attributes, and maps them to terminal-kit's attribute format.
 *
 * @param terminal - The headless xterm terminal to read from
 * @param startRow - First row of the viewport in the terminal buffer
 * @param rows - Number of rows to read
 * @param cols - Number of columns to read
 * @returns 2D array of translated cells [row][col]
 */
export function readTerminalBuffer(
  terminal: import('@xterm/headless').Terminal,
  startRow: number,
  rows: number,
  cols: number,
): TranslatedCell[][];
```

### 4.4 MuxInputHandler

```typescript
// src/mux/mux-input-handler.ts

/**
 * Handles all keyboard input and routes it based on the current mode.
 *
 * Key events come from terminal-kit's `term.on('key')` event, NOT
 * from raw stdin. All stdin interaction goes through terminal-kit's
 * grabInput() to avoid conflicts.
 *
 * In PTY mode: all keystrokes go to the active PtyBridge.write()
 * except Ctrl-A which enters command mode.
 *
 * In command mode: keystrokes are collected in a line buffer.
 * Enter dispatches the command. Ctrl-A returns to PTY mode.
 * Ctrl-A Ctrl-A sends a literal Ctrl-A to the PTY.
 */
export type InputMode = 'pty' | 'command';

export interface MuxInputHandler {
  /** Current input mode. */
  readonly mode: InputMode;

  /** Current command-mode input buffer (for display). */
  readonly inputBuffer: string;

  /**
   * Processes a raw key event from terminal-kit.
   * Returns a MuxAction describing what the orchestrator should do.
   */
  handleKey(key: string, data: Buffer): MuxAction;
}

/**
 * Actions produced by the input handler for the orchestrator to execute.
 */
export type MuxAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'write-pty'; readonly data: string }
  | { readonly kind: 'enter-command-mode' }
  | { readonly kind: 'enter-pty-mode' }
  | { readonly kind: 'command'; readonly command: string; readonly args: string[] }
  | { readonly kind: 'trusted-input'; readonly text: string }
  | { readonly kind: 'redraw-input' }
  | { readonly kind: 'quit' };
```

### 4.5 MuxEscalationManager

```typescript
// src/mux/mux-escalation-manager.ts

import type { ListenerState } from '../escalation/listener-state.js';
import type { EscalationWatcher } from '../escalation/escalation-watcher.js';

/**
 * Manages escalation watchers for all PTY sessions spawned by the mux.
 *
 * Unlike the standalone escalation-listener which discovers sessions
 * via the PTY registry, the mux creates watchers directly when it
 * spawns a session (it knows the escalation directory from the
 * PtyBridge's session registration).
 *
 * For backward compatibility with externally-spawned PTY sessions,
 * it also polls the PTY registry for sessions not spawned by the mux.
 */
export interface MuxEscalationManager {
  /** Current state (sessions, pending escalations, history). */
  readonly state: ListenerState;

  /** Number of pending escalations across all sessions. */
  readonly pendingCount: number;

  /**
   * Registers a new session's escalation directory for watching.
   * Called by MuxApp when a PtyBridge reports its escalation dir.
   */
  addSession(sessionId: string, escalationDir: string, label: string): void;

  /**
   * Removes a session's watcher.
   * Called when a PtyBridge's child process exits.
   */
  removeSession(sessionId: string): void;

  /** Resolves a pending escalation by display number. */
  resolve(displayNumber: number, decision: 'approved' | 'denied'): string;

  /** Resolves all pending escalations. */
  resolveAll(decision: 'approved' | 'denied'): string;

  /** Starts polling for externally-spawned sessions. */
  startRegistryPolling(): void;

  /** Stops all watchers and polling. */
  stop(): void;

  /** Register callback for state changes (triggers redraws). */
  onChange(callback: () => void): void;
}
```

### 4.6 Trusted Input Context

```typescript
// src/mux/trusted-input.ts

/**
 * The user-context.json schema for mux trusted input.
 *
 * Extends the existing { userMessage } schema with a source field
 * that the auto-approver can check to distinguish trusted input from
 * context written by the session (which is in-sandbox and untrusted
 * in PTY mode).
 */
export interface TrustedUserContext {
  /** The user's message text. */
  readonly userMessage: string;
  /** ISO 8601 timestamp when the input was captured. */
  readonly timestamp: string;
  /** Source identifier. Must be "mux-trusted-input" for auto-approver trust. */
  readonly source: 'mux-trusted-input';
}

/**
 * Writes a trusted user context file to the session's escalation directory.
 * Uses atomicWriteJsonSync for crash-safe writes.
 *
 * @param escalationDir - Absolute path to the session's escalation directory
 * @param userMessage - The user's message text
 */
export function writeTrustedUserContext(
  escalationDir: string,
  userMessage: string,
): void;
```

### 4.7 Mux CLI Command

```typescript
// src/mux/mux-command.ts

/**
 * CLI entry point for `ironcurtain mux`.
 *
 * Parses command-line options, loads config, acquires the listener lock,
 * creates the MuxApp, and runs until quit.
 */
export async function main(args?: string[]): Promise<void>;
```

## 5. PTY Bridge Design (Detailed)

The PTY Bridge is the core novel component. It must correctly translate between three different terminal abstractions: the real terminal (which terminal-kit draws to), the headless xterm terminal (which parses ANSI), and the node-pty child process (which produces ANSI).

### 5.1 Data Flow

```
node-pty child process (ironcurtain start --pty)
    │ raw bytes containing ANSI escape sequences
    │ (colors, cursor movement, alternate screen, etc.)
    ▼
pty.onData(data) callback
    │
    ▼
@xterm/headless Terminal.write(data)
    │ parses escape sequences
    │ updates internal buffer: rows × cols of cells
    │ each cell = { char, fg, bg, bold, italic, underline, ... }
    ▼
MuxRenderer (on render tick)
    │ reads Terminal.buffer.active
    │ iterates visible rows [baseY + scrollOffset ... baseY + scrollOffset + viewportRows]
    │ for each cell: extracts char + attributes
    ▼
readTerminalBuffer() → TranslatedCell[][]
    │ maps xterm.js cell attributes to terminal-kit ScreenBuffer cell format:
    │   xterm fg color → terminal-kit color (16-color, 256-color, or 24-bit)
    │   xterm bold/italic/underline → terminal-kit bold/italic/underline
    ▼
terminal-kit ScreenBuffer.put({ x, y, attr, ... }, char)
    │ for each cell that changed since last render
    ▼
ScreenBuffer.draw({ delta: true })
    │ emits only the ANSI sequences needed to update changed cells
    ▼
Real terminal display
```

### 5.2 Attribute Translation

The `@xterm/headless` `IBufferCell` interface provides:
- `getChars()`: the Unicode character(s) in the cell
- `getWidth()`: the display width of the cell (1 for normal, 2 for wide CJK/emoji, 0 for the trailing cell of a wide character)
- `getFgColor()`, `getBgColor()`: color as palette index (0-255) or packed RGB integer
- `getFgColorMode()`, `getBgColorMode()`: `0` = default, `16` = 16-color palette, `256` = 256-color palette, `50331648` = RGB (truecolor)
- `isBold()`, `isItalic()`, `isUnderline()`, `isDim()`, `isInverse()`, `isStrikethrough()`: return `number` (0 or 1), not boolean

**Note on color mode constants:** xterm.js uses internal flag values (`Attributes.CM_DEFAULT = 0`, `CM_P16 = 16`, `CM_P256 = 256`, `CM_RGB = 50331648`). These are not exported as named constants -- the implementer should define them locally. The exact values should be verified against the `@xterm/headless` source at implementation time, as they are internal API.

The translation function maps these to `terminal-kit` ScreenBufferHD attributes. ScreenBufferHD uses `{ r, g, b }` objects for truecolor and integer palette indices for 256-color:

```typescript
/** xterm.js internal color mode flags (verify against @xterm/headless source) */
const CM_DEFAULT = 0;
const CM_P16 = 16;           // was 1 << 4
const CM_P256 = 256;         // was 1 << 8
const CM_RGB = 50331648;     // was 1 << 25

/** Default color sentinel for terminal-kit ScreenBufferHD */
const TK_DEFAULT_COLOR = 'default';

type TermkitColor = number | { r: number; g: number; b: number } | 'default';

function translateColor(mode: number, colorValue: number): TermkitColor {
  switch (mode) {
    case CM_DEFAULT:
      return TK_DEFAULT_COLOR;
    case CM_P16:
    case CM_P256:
      // Palette indices 0-255 map 1:1 between xterm.js and terminal-kit
      return colorValue;
    case CM_RGB:
      // xterm.js packs RGB as a 24-bit integer: 0xRRGGBB
      return {
        r: (colorValue >> 16) & 0xFF,
        g: (colorValue >> 8) & 0xFF,
        b: colorValue & 0xFF,
      };
    default:
      return TK_DEFAULT_COLOR;
  }
}

function translateCell(cell: IBufferCell): TranslatedCell | null {
  // Wide character placeholder cells (trailing cell of CJK/emoji):
  // getWidth() === 0 means this cell is the second column of a wide
  // character. Skip it -- the preceding cell already occupies 2 columns.
  if (cell.getWidth() === 0) return null;

  const char = cell.getChars() || ' ';
  const fg = translateColor(cell.getFgColorMode(), cell.getFgColor());
  const bg = translateColor(cell.getBgColorMode(), cell.getBgColor());

  return {
    char,
    width: cell.getWidth(),   // 1 for normal, 2 for wide characters
    fg,
    bg,
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    dim: cell.isDim() !== 0,
    inverse: cell.isInverse() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
  };
}
```

The `TranslatedCell` type is updated accordingly:

```typescript
export interface TranslatedCell {
  readonly char: string;
  readonly width: number;    // 1 for normal, 2 for wide (CJK/emoji)
  readonly fg: number | { r: number; g: number; b: number } | 'default';
  readonly bg: number | { r: number; g: number; b: number } | 'default';
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly dim: boolean;
  readonly inverse: boolean;
  readonly strikethrough: boolean;
}
```

**Wide character handling in `readTerminalBuffer()`:** When iterating cells, if `translateCell()` returns `null` (width-0 placeholder), the renderer skips that column. The preceding wide character's cell is written to the ScreenBuffer using `terminal-kit`'s wide character support. The ScreenBuffer column counter advances by 2 for wide characters.

### 5.3 Render Throttling and Performance

PTY output can arrive at high frequency (e.g., during a `cat` of a large file). Rendering every byte would overwhelm the terminal. The renderer uses a frame-rate limiter:

```typescript
const MIN_RENDER_INTERVAL_MS = 16; // ~60 FPS max
let renderScheduled = false;
let lastRenderTime = 0;

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;

  const elapsed = Date.now() - lastRenderTime;
  const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed);

  setTimeout(() => {
    renderScheduled = false;
    lastRenderTime = Date.now();
    renderer.redrawPty();
  }, delay);
}
```

Each PtyBridge's `onOutput` callback calls `scheduleRender()`. At most one render is in flight at a time, capped at ~60 FPS.

#### Performance: cell-by-cell buffer reading

For a 200x50 terminal, reading the full buffer means 10,000 cells per frame, with ~11 method calls per cell (`getChars`, `getWidth`, `getFgColor`, `getFgColorMode`, `getBgColor`, `getBgColorMode`, `isBold`, `isItalic`, `isUnderline`, `isDim`, `isInverse`). At 60 FPS, that is ~6.6M method calls/second. Two optimizations keep this manageable:

**1. Reusable cell object.** `@xterm/headless`'s `IBufferLine.getCell(x, cell?)` accepts an optional reusable cell to avoid per-call allocation. The renderer allocates one `CellData` instance and reuses it across all cells:

```typescript
import { CellData } from '@xterm/headless';

const reusableCell = new CellData();

function readTerminalBuffer(terminal: HeadlessTerminal, ...): TranslatedCell[][] {
  const buffer = terminal.buffer.active;
  const result: TranslatedCell[][] = [];

  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.baseY + buffer.cursorY - rows + 1 + y);
    if (!line) { result.push([]); continue; }

    const row: TranslatedCell[] = [];
    for (let x = 0; x < cols; x++) {
      line.getCell(x, reusableCell);          // reuse -- no allocation
      const translated = translateCell(reusableCell);
      if (translated) row.push(translated);   // null = wide char placeholder, skip
    }
    result.push(row);
  }
  return result;
}
```

**2. Dirty-line tracking (future optimization).** If profiling shows the cell-by-cell scan is a bottleneck, add a dirty-line bitmap. xterm.js fires events when lines are modified; the renderer can track which lines changed since the last frame and only read those lines from the buffer. This optimization is deferred to Phase 1 validation -- the reusable cell approach may be sufficient.

### 5.4 Session Discovery

The PtyBridge spawns `ironcurtain start --pty` as a child process. The child writes a registration file to `~/.ironcurtain/pty-registry/session-{id}.json` containing the `sessionId` and `escalationDir`. The mux reads this registration file to learn the session ID and escalation directory path.

Discovery approach: after spawning the child, the mux polls the PTY registry directory for new registration files whose PID matches the child's PID. This reuses the existing registration mechanism without modification.

```typescript
async function discoverSessionRegistration(childPid: number): Promise<PtySessionRegistration | null> {
  const registryDir = getPtyRegistryDir();
  const deadline = Date.now() + 10_000; // 10s timeout

  while (Date.now() < deadline) {
    const registrations = readActiveRegistrations(registryDir);
    const match = registrations.find(r => r.pid === childPid);
    if (match) return match;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}
```

## 6. Screen Layout

### 6.1 Constant PTY Viewport (No Reflow on Mode Switch)

**Critical design choice:** The PTY viewport size is constant regardless of input mode. The command-mode UI (escalation panel, hint bar, input line) **overlays** the bottom of the PTY viewport rather than shrinking it. This prevents xterm.js reflow on every `Ctrl-A` toggle, which would rearrange wrapped lines and disorient the user.

The headless terminal and node-pty child are always sized to `terminal rows - 2` (tab bar + footer). The command-mode overlay paints over the bottom rows of the PTY content, hiding them temporarily. When the user returns to PTY mode, the full PTY content is visible again without any reflow.

### 6.2 PTY Mode (Default)

```
┌──────────────────────────────────────────────────────────────────────┐
│ [#1 claude-code] [#2 claude-code]                       [!2 pending]│  ← tab bar (1 row)
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│         Active PTY session output                                    │
│         (full @xterm/headless rendering)                             │
│                                                                      │
│         Height = terminal rows - 2 (CONSTANT)                        │
│                                                                      │
│                                                                      │
│                                                                      │
│                                                                      │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ [PTY #1]  Ctrl-A → cmd                                              │  ← footer (1 row)
└──────────────────────────────────────────────────────────────────────┘
```

### 6.3 Command Mode (No Pending Escalations)

The hint bar and input line overlay the last 2 rows of the PTY viewport. The PTY is NOT resized.

```
┌──────────────────────────────────────────────────────────────────────┐
│ [#1 claude-code] [#2 claude-code]                                   │  ← tab bar (1 row)
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│         Active PTY session output                                    │
│         (same height -- NOT resized)                                 │
│                                                                      │
│                                                                      │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │ (PTY content hidden behind overlay)                          │   │
│  ├───────────────────────────────────────────────────────────────┤   │
│  │ [CMD] /approve · /deny · /new · /tab N · Ctrl-A → PTY       │   │  ← hint bar (overlay)
│  │ > _                                                          │   │  ← input line (overlay)
└──┴───────────────────────────────────────────────────────────────┴───┘
```

### 6.4 Command Mode (With Pending Escalations)

Escalation panel + hint bar + input line overlay the bottom N rows. Max overlay height is capped at 8 rows to keep most of the PTY visible.

```
┌──────────────────────────────────────────────────────────────────────┐
│ [#1 claude-code] [#2 claude-code]                       [!2 pending]│  ← tab bar (1 row)
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│         Active PTY session output                                    │
│         (same height -- NOT resized)                                 │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │ (PTY content hidden behind overlay)                          │   │
│  ├───────────────────────────────────────────────────────────────┤   │
│  │ [1] Session #1  filesystem/write_file                        │   │  ← escalation panel
│  │     Reason: Write outside sandbox                            │   │    (overlay)
│  │ [2] Session #2  git/git_push                                  │   │
│  │     Reason: Not in allow list                                │   │
│  ├───────────────────────────────────────────────────────────────┤   │
│  │ [CMD] /approve N · /deny N · /approve all · Ctrl-A → PTY    │   │  ← hint bar (overlay)
│  │ > _                                                          │   │  ← input line (overlay)
└──┴───────────────────────────────────────────────────────────────┴───┘
```

### 6.5 Row Budget Calculations

```typescript
const TAB_BAR_ROWS = 1;
const FOOTER_ROWS = 1;
const HINT_BAR_ROWS = 1;        // command mode hint bar (overlay)
const INPUT_LINE_ROWS = 1;       // command mode input line (overlay)
const ESCALATION_ROWS_PER_ITEM = 2;
const MAX_ESCALATION_PANEL_ROWS = 6;
const MAX_OVERLAY_ROWS = 8;      // cap total overlay height

/**
 * The PTY viewport is CONSTANT: totalRows - TAB_BAR_ROWS - FOOTER_ROWS.
 * The headless terminal and node-pty child are always this size.
 *
 * In command mode, the overlay paints over the bottom rows of the
 * PTY viewport. The overlay height is calculated here for the renderer.
 */
function calculateLayout(totalRows: number, mode: InputMode, pendingCount: number): Layout {
  const ptyViewportRows = Math.max(1, totalRows - TAB_BAR_ROWS - FOOTER_ROWS);

  let overlayRows = 0;
  let escalationPanelRows = 0;

  if (mode === 'command') {
    if (pendingCount > 0) {
      escalationPanelRows = Math.min(
        pendingCount * ESCALATION_ROWS_PER_ITEM,
        MAX_ESCALATION_PANEL_ROWS,
      );
    }
    overlayRows = Math.min(
      escalationPanelRows + HINT_BAR_ROWS + INPUT_LINE_ROWS,
      MAX_OVERLAY_ROWS,
    );
  }

  return {
    tabBarY: 0,
    ptyViewportY: TAB_BAR_ROWS,
    ptyViewportRows,              // CONSTANT -- never changes on mode switch
    footerY: TAB_BAR_ROWS + ptyViewportRows,
    overlayRows,                  // 0 in PTY mode, >0 in command mode
    overlayY: TAB_BAR_ROWS + ptyViewportRows - overlayRows,
    escalationPanelRows,
  };
}
```

**Resize behavior:** When the terminal is resized (SIGWINCH), the PTY viewport height changes because the terminal dimensions changed -- this is expected and does cause xterm.js reflow. But mode switching (`Ctrl-A`) does NOT change the viewport height, so it never causes reflow. Only actual terminal resizes trigger reflow.

## 7. Trusted Input Flow (Detailed)

This is the key security innovation. It provides the missing trusted input path for PTY mode, enabling the auto-approver.

### 7.1 Flow Diagram

```
User types "push my changes to origin" in command mode, presses Enter
    │
    ├── 1. MuxInputHandler captures text host-side
    │      (the text never touched the sandbox)
    │
    ├── 2. MuxApp calls writeTrustedUserContext():
    │      atomicWriteJsonSync(escalationDir + '/user-context.json', {
    │        userMessage: "push my changes to origin",
    │        timestamp: "2026-03-02T...",
    │        source: "mux-trusted-input"
    │      })
    │
    ├── 3. MuxApp forwards text to active PtyBridge:
    │      bridge.write("push my changes to origin\n")
    │      (Claude Code sees this as user input in its PTY)
    │
    ▼
Later, Claude Code makes a git_push tool call
    │
    ▼
MCP Proxy (mcp-proxy-server.ts) evaluates policy → escalate
    │
    ▼
Auto-approver reads user-context.json:
    - userMessage: "push my changes to origin"
    - source: "mux-trusted-input"  ← trusted source check passes
    │
    ▼
Auto-approver calls LLM: "push to origin" matches git_push → approve
    │
    ▼
Tool call proceeds without human escalation
```

### 7.2 Trust Model

The security guarantee depends on the following invariant:

**Only the mux process (running host-side) can write to the escalation directory.** The escalation directory is inside `~/.ironcurtain/sessions/{id}/escalations/`, which is NOT bind-mounted into the Docker container. The container only has access to `sockets/` (for UDS proxies), `sandbox/` (for the workspace), and `/etc/ironcurtain` (for read-only orientation). Therefore:

- The sandbox cannot write to `user-context.json`
- The sandbox cannot overwrite `user-context.json` with a malicious message
- Text captured in the mux's command mode is guaranteed to be from the human user

The auto-approver in `mcp-proxy-server.ts` already reads `user-context.json` from the escalation directory. The only change needed is to optionally check the `source` field when auto-approving PTY sessions.

### 7.3 Auto-Approver Integration

The auto-approver's `readUserContext()` function in `src/trusted-process/auto-approver.ts` currently reads `{ userMessage }` and returns the string. It needs to be extended to also parse the `source` field:

```typescript
export interface UserContext {
  readonly userMessage: string;
  readonly source?: string;
}

export function readUserContext(escalationDir: string): UserContext | null {
  try {
    const contextPath = resolve(escalationDir, 'user-context.json');
    const data = JSON.parse(readFileSync(contextPath, 'utf-8')) as Record<string, unknown>;
    const { userMessage, source } = data;
    if (typeof userMessage !== 'string' || !userMessage.trim()) return null;
    return {
      userMessage,
      source: typeof source === 'string' ? source : undefined,
    };
  } catch {
    return null;
  }
}
```

In the proxy, when auto-approving PTY sessions, the `source` field is checked:

```typescript
// In mcp-proxy-server.ts, inside the escalation handling block:
const context = readUserContext(deps.escalationDir);
if (context) {
  // For PTY sessions, require trusted source.
  // For standard sessions, any source (or no source) is accepted
  // since the session process writes user-context.json directly.
  const isPtySession = Boolean(process.env.IRONCURTAIN_PTY_SESSION);
  if (isPtySession && context.source !== 'mux-trusted-input') {
    // Skip auto-approve -- fall through to human escalation
  } else {
    // Check staleness: reject trusted input older than 120 seconds
    if (context.timestamp) {
      const age = Date.now() - new Date(context.timestamp).getTime();
      if (age > TRUSTED_INPUT_STALENESS_MS) {
        // Stale context -- fall through to human escalation
      }
    }
    const autoResult = await autoApprove(/* ... */);
    // ...
  }
}

const TRUSTED_INPUT_STALENESS_MS = 120_000; // 2 minutes
```

**Note:** The `IRONCURTAIN_PTY_SESSION` environment variable does not currently exist in the codebase. It must be added to the proxy's environment setup in `pty-session.ts` as part of this work. Specifically, `proxyEnv` in `pty-session.ts` (where `AUTO_APPROVE_*` env vars are set) must include `IRONCURTAIN_PTY_SESSION: '1'`. This ensures the proxy can distinguish PTY sessions from standard sessions when gating auto-approval on the `source` field.

## 8. Command Handling

### 8.1 Command Mode Commands

| Command | Description | Implementation |
|---------|-------------|----------------|
| `/approve N` | Approve escalation #N | Delegates to `MuxEscalationManager.resolve(N, 'approved')` |
| `/approve all` | Approve all pending escalations | Delegates to `MuxEscalationManager.resolveAll('approved')` |
| `/deny N` | Deny escalation #N | Delegates to `MuxEscalationManager.resolve(N, 'denied')` |
| `/deny all` | Deny all pending | Delegates to `MuxEscalationManager.resolveAll('denied')` |
| `/new` | Spawn a new PTY session tab | Creates a new PtyBridge, adds to tab list |
| `/tab N` | Switch to tab N | Changes active tab, triggers full redraw |
| `/close N` | Close tab N (kills child process) | Calls `PtyBridge.kill()`, removes from tab list |
| `/sessions` | Show session details | Displays session info in the escalation panel area |
| `/quit` or `/q` | Exit multiplexer | Triggers `MuxApp.shutdown()` |
| (any other text) | Trusted user input | Writes `user-context.json`, forwards to PTY |

### 8.2 Keyboard Shortcuts (PTY Mode)

| Key | Action |
|-----|--------|
| `Ctrl-A` | Enter command mode |
| `Ctrl-\` | Forwarded to active PTY (child handles as emergency exit -- see Section 3.9) |
| All other keys | Forward to active PTY |

### 8.3 Keyboard Shortcuts (Command Mode)

| Key | Action |
|-----|--------|
| `Ctrl-A` | Return to PTY mode (if input buffer empty) or send literal `Ctrl-A` (if preceded by another `Ctrl-A`) |
| `Enter` | Dispatch command or send trusted input |
| `Escape` | Return to PTY mode, discard input buffer |
| `Ctrl-C` | Clear input buffer |
| `Alt-1` through `Alt-9` | Switch to tab 1-9 (quick tab switching without `/tab`) |
| `Backspace` | Delete character |
| Arrow keys | Cursor movement within input line |

## 9. Component Relationships

```
src/mux/mux-command.ts
    │  CLI entry point: parses args, loads config, acquires lock
    │
    ▼
src/mux/mux-app.ts
    │  Orchestrator: creates and owns all components
    │
    ├──► src/mux/pty-bridge.ts (one per tab)
    │      │  Owns: node-pty child + @xterm/headless Terminal
    │      │  Reads: ~/.ironcurtain/pty-registry/ (session discovery)
    │      │
    │      └──► ironcurtain start --pty (child process)
    │             │
    │             └──► Docker container + proxies (existing infrastructure)
    │
    ├──► src/mux/mux-renderer.ts
    │      │  Owns: terminal-kit ScreenBuffer
    │      │  Reads: PtyBridge.terminal.buffer (headless xterm)
    │      │  Calls: readTerminalBuffer() for attribute translation
    │      │
    │      └──► terminal-kit (real terminal output)
    │
    ├──► src/mux/mux-input-handler.ts
    │      │  Routes keystrokes based on mode
    │      │  Produces MuxAction values for MuxApp
    │      │
    │      └──► terminal-kit (raw key input)
    │
    ├──► src/mux/mux-escalation-manager.ts
    │      │  Reuses: src/escalation/escalation-watcher.ts
    │      │  Reuses: src/escalation/listener-state.ts
    │      │  Reuses: src/escalation/session-registry.ts
    │      │
    │      └──► Escalation directories (file-based IPC)
    │
    └──► src/mux/trusted-input.ts
           │  Writes: user-context.json to escalation dir
           │  Uses: atomicWriteJsonSync from escalation-watcher.ts
           │
           └──► Auto-approver (reads user-context.json in proxy process)

Reused modules (unchanged):
  src/escalation/escalation-watcher.ts  ← polls escalation dirs
  src/escalation/listener-state.ts      ← immutable state management
  src/escalation/session-registry.ts    ← reads PTY registry
  src/config/paths.ts                   ← getPtyRegistryDir(), getListenerLockPath()
```

## 10. Security Considerations

### 10.1 Trusted input is protected from sandbox manipulation

The escalation directory (`~/.ironcurtain/sessions/{id}/escalations/`) is never bind-mounted into the Docker container. The container's bind mounts are limited to:
- `sockets/` at `/run/ironcurtain` (UDS proxies)
- `sandbox/` at `/workspace` (workspace files)
- `orientationDir` at `/etc/ironcurtain` (read-only config)

This is enforced in `pty-session.ts` (line 231-236 for Linux, 219-222 for macOS) and `docker-infrastructure.ts`. A compromised sandbox cannot write to `user-context.json`.

The `source: "mux-trusted-input"` field provides defense-in-depth: even if a future code change accidentally exposed the escalation directory, the auto-approver would only trust contexts with this specific source value when operating in PTY mode.

### 10.2 Auto-approver integration

The auto-approver continues to operate in the proxy process (`mcp-proxy-server.ts`), reading `user-context.json` from the escalation directory. The changes are:

1. `readUserContext()` returns both `userMessage`, `source`, and `timestamp`
2. For PTY sessions (detected via `IRONCURTAIN_PTY_SESSION` env var, which must be added to the proxy env in `pty-session.ts`), the proxy requires `source === 'mux-trusted-input'` before calling the auto-approver
3. A staleness check rejects `user-context.json` older than 120 seconds (see Section 10.6)
4. For standard sessions, the existing behavior is unchanged (no source or staleness check required)

The auto-approver can never deny, only approve or escalate. This invariant is unchanged.

### 10.3 Terminal safety

Raw mode restoration is critical. If the mux crashes without restoring the terminal, the user's shell becomes unusable (no echo, no line editing). The mux implements multiple safety layers:

```typescript
// 1. process.on('exit') handler -- always runs, even on uncaught exceptions
process.on('exit', () => {
  terminalKit.grabInput(false);
  // terminal-kit's own cleanup runs here via its internal exit handler
});

// 2. Signal handlers for SIGINT, SIGTERM, SIGHUP
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    shutdown().finally(() => process.exit(128 + signalNumber(signal)));
  });
}

// 3. Ctrl-A q emergency exit
// The mux does NOT intercept Ctrl-\ (0x1c). The child process
// (ironcurtain start --pty) already handles Ctrl-\ as its own
// emergency exit, which would kill the child and trigger the
// mux's onExit handler. Instead, the mux uses Ctrl-A q as its
// emergency exit: enters command mode and immediately quits.
// If the user needs to kill the mux when Ctrl-A is not responsive,
// they can use kill(1) from another terminal.

// 4. terminal-kit's own cleanup
// terminal-kit registers its own process.on('exit') handler
// that restores terminal state. This is a safety net.
```

### 10.4 Single-instance enforcement

The mux acquires `~/.ironcurtain/escalation-listener.lock` (the same lock used by `ironcurtain escalation-listener`) using the existing `acquireLock()` function from `listener-command.ts`. This prevents:

- Two mux instances from conflicting on escalation resolution
- A mux and an escalation listener from running simultaneously
- Orphan lock files from crashed processes (PID liveness check)

The lock management code should be extracted from `listener-command.ts` into a shared utility (`src/escalation/listener-lock.ts`) for reuse.

### 10.5 Trusted input staleness (TOCTOU mitigation)

There is a time-of-check-to-time-of-use gap between when the user types trusted input and when the auto-approver reads it. The user could type "push to origin" in command mode (writing `user-context.json`), then switch to PTY mode and type "push to evil-fork" directly into the PTY. The auto-approver would read the stale trusted context and approve based on the wrong intent.

**Mitigation:** The auto-approver checks the `timestamp` field in `user-context.json`. If the context is older than `TRUSTED_INPUT_STALENESS_MS` (120 seconds / 2 minutes), the auto-approver skips auto-approval and falls through to human escalation. This bounds the TOCTOU window: the user's trusted input is only valid for a short period after they typed it.

The 120-second window is a pragmatic choice: long enough that the agent can process the user's instruction and make tool calls, short enough that stale context from a previous conversation turn is unlikely to be used. This value is currently implemented as a fixed constant (`TRUSTED_INPUT_STALENESS_MS`) in `mcp-proxy-server.ts`; future work may make it configurable via user configuration.

**Residual risk:** Within the staleness window, a compromised sandbox could still exploit the mismatch between trusted context and actual PTY input. This is acceptable because (a) the auto-approver's LLM prompt is conservative and matches on specific intent, not broad categories, and (b) the policy engine's argument-level checks (via `extractArgsForAutoApprove`) catch mismatches between the stated intent and the actual tool arguments when annotations include resource-identifier roles.

### 10.6 `source` field is not cryptographic -- Docker isolation is the trust root

The `source: "mux-trusted-input"` field is a plain string, not a cryptographic attestation. Any host-side process running as the same user could write a forged `user-context.json` with this source value to the escalation directory.

This is acceptable because the trust root is **Docker container isolation**, not the source field. The source field provides defense-in-depth:

- In **Docker Agent Mode** (the primary target): the container cannot access the escalation directory. The source field adds a second layer in case a future code change accidentally exposes the directory.
- In **Code Mode** (bubblewrap sandbox): the sandbox has weaker isolation. The source field provides no meaningful security here. However, Code Mode uses `TrustedProcess` in-process (not the proxy), and the `setLastUserMessage()` method is called directly by the session -- so Code Mode does not need the `source` field mechanism at all.

This limitation should be documented in user-facing auto-approver docs: auto-approve in PTY mode is designed for Docker Agent Mode.

### 10.7 Child process credential isolation

The mux spawns `ironcurtain start --pty` as a child process. The child process sets up Docker containers with fake credentials (existing security model). The mux never handles real API keys directly -- it delegates to the existing PTY session infrastructure.

## 11. Error Handling

### 11.1 PTY session crashes

When a child process exits unexpectedly:

```typescript
bridge.onExit((exitCode) => {
  // Mark the tab as exited
  tab.status = 'exited';
  tab.exitCode = exitCode;

  // Stop the escalation watcher for this session
  escalationManager.removeSession(bridge.sessionId);

  // Preserve the last rendered state in the headless terminal buffer
  // so the user can see what happened before the crash

  // Update the tab bar to show [exited] status
  renderer.redrawTabBar();

  // If this was the active tab, show a message in the footer
  if (tab === activeTab) {
    renderer.showMessage(`Session #${tab.number} exited with code ${exitCode}`);
  }

  // BEL to alert user
  process.stdout.write('\x07');
});
```

The user can close the exited tab with `/close N` or spawn a new one with `/new`.

### 11.2 Resize events (SIGWINCH)

On terminal resize, **all** bridges (active and inactive) are resized immediately. This ensures that output produced by inactive sessions is formatted for the correct terminal width, preventing garbled display when the user switches back to them.

```typescript
process.stdout.on('resize', () => {
  const { columns, rows } = process.stdout;
  if (!columns || !rows) return;

  renderer.resize(columns, rows);

  // Resize ALL bridges -- active and inactive
  const layout = calculateLayout(rows, inputHandler.mode, escalationManager.pendingCount);
  for (const bridge of allBridges) {
    bridge.resize(columns, layout.ptyViewportRows);
  }

  renderer.fullRedraw();
});
```

Resizing all bridges costs one `docker exec resize-pty.sh` call per inactive session, but this is acceptable:
- Terminal resizes are infrequent (human-initiated)
- `docker exec` is fast (~50ms)
- Incorrect terminal width causes garbled output that is much worse than the resize cost

The headless terminal resize triggers xterm.js's reflow, which re-wraps lines. The `node-pty` resize sends a `SIGWINCH` to the child process. The child's `ironcurtain start --pty` forwards the resize to the Docker container via `docker exec resize-pty.sh` (existing mechanism). This chain works naturally through the double-PTY layer (see Section 3.9).

### 11.3 Render errors

If `terminal-kit`'s ScreenBuffer operations throw:

```typescript
try {
  screenBuffer.draw({ delta: true });
} catch (err) {
  // Fall back to a full redraw (clears delta state)
  try {
    screenBuffer.draw({ delta: false });
  } catch {
    // Terminal is in a bad state -- log and continue
    // The next render tick will try again
    logger.warn(`Render error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

Render errors are never fatal. The worst case is a briefly garbled display that self-corrects on the next full redraw (triggered by resize, mode switch, or tab switch).

### 11.4 node-pty spawn failures

If `node-pty` fails to spawn the child process:

```typescript
try {
  const bridge = createPtyBridge(options);
  tabs.push(bridge);
} catch (err) {
  // Show error in the command mode output area
  renderer.showMessage(`Failed to spawn session: ${err instanceof Error ? err.message : String(err)}`);

  // If this was the first tab and no other tabs exist, exit
  if (tabs.length === 0) {
    await shutdown();
    process.exit(1);
  }
}
```

Common failure modes:
- `node-pty` native module not compiled for the current platform
- `ironcurtain` binary not found in PATH
- Docker not available (the child will fail during Docker setup)

### 11.5 Escalation directory discovery failure

If the mux cannot discover a child's session registration within the timeout:

```typescript
const registration = await discoverSessionRegistration(childPid);
if (!registration) {
  logger.warn(`Could not discover session registration for PID ${childPid}`);
  // The tab works for display but has no escalation watching
  // and no trusted input (no escalation directory to write to)
  tab.escalationAvailable = false;
}
```

The tab remains functional for PTY display but escalations must be handled by an external listener (if one is running) and trusted input is unavailable for that session.

## 12. Testing Strategy

### 12.1 Unit tests

**PtyBridge (`test/mux-pty-bridge.test.ts`)**
- Creates a PtyBridge with a simple echo program (not `ironcurtain start --pty`)
- Verifies that output written to the child appears in the headless terminal buffer
- Verifies that `write()` sends data to the child's stdin
- Verifies that `resize()` updates both the headless terminal and the child
- Verifies that `kill()` terminates the child and fires the exit callback
- Verifies the exit callback fires with correct exit code on normal exit

**MuxInputHandler (`test/mux-input-handler.test.ts`)**
- In PTY mode: all keys produce `write-pty` actions
- `Ctrl-A` in PTY mode produces `enter-command-mode`
- In command mode: typing + Enter produces `command` or `trusted-input` actions
- `Ctrl-A` in command mode produces `enter-pty-mode`
- `Ctrl-A Ctrl-A` in PTY mode produces `write-pty` with `\x01`
- `/approve 1` parses correctly
- `/approve all` parses correctly
- Non-command text produces `trusted-input`
- `Escape` clears input buffer and returns to PTY mode

**MuxEscalationManager (`test/mux-escalation-manager.test.ts`)**
- Adding a session starts an escalation watcher
- Removing a session stops the watcher
- Pending escalation count updates correctly
- `resolve()` writes response file and updates state
- `resolveAll()` resolves all pending escalations
- State change callback fires on escalation add/resolve

**readTerminalBuffer (`test/mux-renderer.test.ts`)**
- Translates basic text (no attributes) correctly
- Translates bold, italic, underline
- Translates 16-color palette
- Translates 256-color palette
- Translates 24-bit RGB colors
- Handles empty cells (spaces)
- Handles wide characters (CJK, emoji)

**Trusted input (`test/mux-trusted-input.test.ts`)**
- `writeTrustedUserContext()` writes correct JSON
- Written file includes `source: "mux-trusted-input"`
- Written file includes ISO 8601 timestamp
- Uses atomic write (no `.tmp` file left behind)
- Overwrites previous context file

**Layout calculations (`test/mux-layout.test.ts`)**
- PTY mode: viewport = totalRows - 2 (tab bar + footer)
- Command mode, no escalations: viewport = totalRows - 3 (tab bar + hint bar + input)
- Command mode, 2 escalations: viewport = totalRows - 3 - 4 (2 * 2 rows)
- Command mode, 10 escalations: escalation panel capped at 6 rows
- Minimum viewport height is 1 row

### 12.2 Integration tests

**End-to-end smoke test (`test/mux-integration.test.ts`)**
- Spawns a MuxApp with a simple shell command (e.g., `bash`) instead of `ironcurtain start --pty`
- Verifies the headless terminal receives output
- Sends keystrokes and verifies they reach the child
- Tests mode switching (Ctrl-A)
- Tests command parsing in command mode
- Requires: `node-pty` native module, TTY-capable test environment

This test will be skipped in CI if no TTY is available (`process.stdout.isTTY`).

### 12.3 Manual testing checklist

- [ ] Start `ironcurtain mux` -- initial session spawns and renders
- [ ] Type in Claude Code -- keystrokes arrive, output renders correctly
- [ ] Colors, bold, cursors render correctly (verify with `htop` or `vim` in container)
- [ ] `Ctrl-A` enters command mode -- hint bar and input line appear
- [ ] `/new` spawns a second session tab
- [ ] `/tab 2` switches to the second tab
- [ ] `Alt-1` switches back to the first tab
- [ ] Resize terminal window -- PTY adjusts correctly
- [ ] Trigger an escalation -- badge appears in tab bar, BEL sounds
- [ ] Enter command mode -- escalation details show in panel
- [ ] `/approve 1` resolves the escalation
- [ ] Type non-command text in command mode -- forwarded to PTY as user input
- [ ] Verify `user-context.json` written with `source: "mux-trusted-input"`
- [ ] Kill a child process externally -- tab shows [exited]
- [ ] `/close` removes an exited tab
- [ ] `/quit` exits cleanly, terminal restored
- [ ] `Ctrl-A q` emergency exit works, terminal restored
- [ ] `Ctrl-\` is forwarded to child (kills child, mux stays running)
- [ ] Start `ironcurtain escalation-listener` while mux is running -- rejected (lock)
- [ ] Start second `ironcurtain mux` -- rejected (lock)

## 13. Files Changed

### New files

| File | Responsibility |
|------|---------------|
| `src/mux/mux-command.ts` | CLI entry point for `ironcurtain mux`. Parses args, loads config, acquires listener lock, creates MuxApp, runs event loop. |
| `src/mux/mux-app.ts` | Top-level orchestrator. Creates and owns all components. Handles the MuxAction dispatch loop. Manages tab lifecycle. |
| `src/mux/pty-bridge.ts` | Spawns `node-pty` child process, wires to `@xterm/headless` Terminal, provides `write()`/`resize()`/`kill()` interface. Discovers session registration for escalation dir. |
| `src/mux/mux-renderer.ts` | Composes tab bar, PTY viewport, escalation panel, hint bar, and input line into a `terminal-kit` ScreenBuffer. Implements `readTerminalBuffer()` for xterm-to-terminal-kit cell translation. Delta rendering. |
| `src/mux/mux-input-handler.ts` | Key routing state machine. Two modes: PTY (forward to bridge) and command (collect in buffer, dispatch on Enter). Produces `MuxAction` values. |
| `src/mux/mux-escalation-manager.ts` | Wraps `EscalationWatcher` and `ListenerState` for the mux context. Manages per-session watchers, provides resolve/resolveAll, fires change callbacks. |
| `src/mux/trusted-input.ts` | `writeTrustedUserContext()` function. Writes `{ userMessage, timestamp, source }` to `user-context.json` via `atomicWriteJsonSync()`. |
| `src/mux/types.ts` | Shared types: `MuxTab`, `MuxAction`, `InputMode`, `Layout`, etc. |
| `src/escalation/listener-lock.ts` | Lock management extracted from `listener-command.ts`: `acquireLock()`, `releaseLock()`, `isPidAlive()`. Shared between mux and escalation-listener. |
| `test/mux-pty-bridge.test.ts` | Unit tests for PtyBridge. |
| `test/mux-input-handler.test.ts` | Unit tests for MuxInputHandler. |
| `test/mux-escalation-manager.test.ts` | Unit tests for MuxEscalationManager. |
| `test/mux-renderer.test.ts` | Unit tests for `readTerminalBuffer()` and layout calculations. |
| `test/mux-trusted-input.test.ts` | Unit tests for trusted input writing. |

### Modified files

| File | Change |
|------|--------|
| `src/cli.ts` | Add `case 'mux':` to import and run `src/mux/mux-command.ts`. Add `mux` to help text. |
| `src/escalation/listener-command.ts` | Extract lock management into `src/escalation/listener-lock.ts`. Import from new location. |
| `src/trusted-process/auto-approver.ts` | Extend `readUserContext()` to return `{ userMessage, source? }` instead of just `string`. Add `UserContext` interface. |
| `src/trusted-process/mcp-proxy-server.ts` | Add `source` check and staleness check on `readUserContext()` result for PTY sessions: require `source === 'mux-trusted-input'` and `timestamp` within staleness window when `IRONCURTAIN_PTY_SESSION` env var is set. |
| `src/docker/pty-session.ts` | Add `IRONCURTAIN_PTY_SESSION: '1'` to `proxyEnv` so the proxy can detect PTY sessions for auto-approver source gating. |
| `package.json` | Add dependencies: `terminal-kit@3.1.2`, `@xterm/headless@6.0.0`. Add `node-pty@1.1.0` as `optionalDependency`. |
| `docs/designs/terminal-multiplexer.md` | This design document. |

## 14. Migration Plan

### Phase 1: Core infrastructure (1 PR)

**Goal:** PtyBridge and renderer working with a simple test program.

1. Add `@xterm/headless`, `terminal-kit` to `dependencies` and `node-pty` to `optionalDependencies` in `package.json`
2. Create `src/mux/pty-bridge.ts` -- spawn child, wire to headless xterm
3. Create `src/mux/mux-renderer.ts` -- `readTerminalBuffer()`, ScreenBuffer rendering, layout calculations
4. Create `src/mux/types.ts` -- shared types
5. Write unit tests for PtyBridge (using `echo`/`cat` programs) and `readTerminalBuffer()` (with mock xterm buffers)
6. Validate: a PtyBridge connected to `bash` renders correctly in a ScreenBuffer

### Phase 2: Input handling and tab management (1 PR)

**Goal:** Full keyboard handling, mode switching, tab management.

1. Create `src/mux/mux-input-handler.ts` -- key routing state machine
2. Create `src/mux/mux-app.ts` -- orchestrator with tab lifecycle
3. Implement mode switching (Ctrl-A), command parsing, tab switching
4. Write unit tests for MuxInputHandler
5. Validate: user can type in PTY, switch modes, switch tabs

### Phase 3: Escalation management (1 PR)

**Goal:** In-band escalation handling replaces separate listener.

1. Extract lock management from `listener-command.ts` into `src/escalation/listener-lock.ts`
2. Create `src/mux/mux-escalation-manager.ts` -- wraps existing watcher/state modules
3. Integrate escalation panel into renderer
4. Implement `/approve`, `/deny`, `/approve all`, `/deny all` commands
5. Write unit tests for MuxEscalationManager
6. Validate: escalations appear in panel, can be approved/denied

### Phase 4: Trusted input and auto-approver integration (1 PR)

**Goal:** Trusted input path enables auto-approver in PTY mode.

1. Create `src/mux/trusted-input.ts` -- `writeTrustedUserContext()`
2. Extend `readUserContext()` in `auto-approver.ts` to return `{ userMessage, source?, timestamp? }` instead of `string`
3. Add `IRONCURTAIN_PTY_SESSION=1` to `proxyEnv` in `pty-session.ts`
4. Add `source` check and staleness check in `mcp-proxy-server.ts` for PTY sessions
5. Wire trusted input into MuxApp: non-command text writes context then forwards to PTY
6. Write unit tests for trusted input and staleness logic
7. Validate end-to-end: user types text in command mode, auto-approver receives it, approves matching escalation
8. Validate staleness: old context is rejected, escalation falls through to human

### Phase 5: CLI integration and polish (1 PR)

**Goal:** `ironcurtain mux` is a working command.

1. Create `src/mux/mux-command.ts` -- CLI entry point
2. Add `case 'mux':` to `src/cli.ts`
3. Update help text
4. Integration testing
5. Add deprecation notice to `ironcurtain escalation-listener` pointing users to `ironcurtain mux`

## 15. Future Extensions

### 15.1 Scrollback

The headless xterm terminal maintains a scrollback buffer. A future enhancement could let the user scroll through PTY history in command mode using `Shift+PageUp`/`Shift+PageDown`. This is straightforward to implement since the buffer already exists -- it only needs UI for scrolling.

### 15.2 Session persistence

Currently, exiting the mux kills all child processes. A future version could detach sessions (like `tmux detach`) and reattach later. This would require the child `ironcurtain start --pty` processes to survive the mux exit, which conflicts with the current cleanup model.

### 15.3 Copy/paste

Mouse selection and copy/paste support using terminal-kit's mouse handling. The selected text would be copied to the system clipboard via OSC 52 escape sequences.

### 15.4 Split panes

Instead of tabs, display multiple sessions simultaneously in split panes. This increases complexity significantly (proportional resize, focus management) and is deferred.

### 15.5 Auto-approver feedback

Show a notification in the footer when the auto-approver auto-approves an escalation, so the user knows it happened. This requires a new IPC mechanism from the proxy to the mux (the proxy currently has no way to notify the session that an auto-approval occurred).

---

### Critical Files for Implementation

- `/workspace/ironcurtain/src/escalation/listener-command.ts` - Contains lock management and command handling code to extract and reuse
- `/workspace/ironcurtain/src/trusted-process/auto-approver.ts` - Must extend `readUserContext()` to support the `source` field for trusted input verification
- `/workspace/ironcurtain/src/trusted-process/mcp-proxy-server.ts` - Must add source-field check for PTY session auto-approval gate
- `/workspace/ironcurtain/src/escalation/listener-state.ts` - Immutable state management to reuse directly in the escalation manager
- `/workspace/ironcurtain/src/docker/pty-session.ts` - Reference implementation for PTY session spawning, registration, and cleanup patterns