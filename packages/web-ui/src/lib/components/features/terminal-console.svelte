<script lang="ts">
  /**
   * Presentational xterm.js terminal for a `web-pty` (Container Agent Mode)
   * session. Renders the container's live TUI streamed over the WebSocket.
   *
   * Layering: this is a `features/` component — it takes data via props /
   * callbacks and exposes imperative handles; it MUST NOT import the store.
   * When the terminal mounts it hands the Sessions route a live
   * `{ write, reset }` handle via `onready`; the route connects that to the
   * buffering per-label sink (which drains any frames that arrived before the
   * terminal existed — a fast replay can beat this component's mount).
   *
   * The terminal is created in `onMount`, NOT a `$effect`: the route passes
   * inline callback props whose identity changes on every parent re-render, and
   * a reactive `$effect` re-runs on that churn — disposing and recreating the
   * terminal, which drops the one-shot replay and the scrollback. `onMount`
   * runs exactly once per mount, immune to that reactivity.
   */
  import { onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import type { PtySink } from '../../types.js';
  import { encodeB64Utf8, decodeB64Utf8ToBytes } from '../../pty-codec.js';

  let {
    onready,
    oninput,
    onresize,
  }: {
    /** Called once the xterm terminal exists, with a live `{ write, reset }` handle. */
    onready: (handle: PtySink) => void;
    /** Every keystroke (control chars, arrows, fn keys, bracketed paste), base64 of UTF-8 bytes. */
    oninput: (dataB64: string) => void;
    /** Fired after a fit so the daemon can adopt this browser's terminal size. */
    onresize: (cols: number, rows: number) => void;
  } = $props();

  let containerEl: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;

  export function fit(): void {
    fitAddon?.fit();
  }

  export function focus(): void {
    term?.focus();
  }

  onMount(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      // Match the headless bridge's scrollback cap so local scroll depth is consistent.
      scrollback: 5000,
    });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(containerEl);
    addon.fit();

    // Keyboard: `onData` forwards every keystroke to the child PTY stdin.
    // Sufficient for keyboard input — we deliberately do NOT wire `onBinary`
    // or app mouse-mode forwarding in v1 (mux parity): the scroll wheel drives
    // xterm's local scrollback and text selection is preserved.
    // NOTE: Ctrl/Cmd+C is SIGINT to the agent, not copy — we rely on xterm's
    // default selection + Cmd/Ctrl+Shift+C for copy and never bind Ctrl+C.
    const dataSub = terminal.onData((s) => oninput(encodeB64Utf8(s)));

    term = terminal;
    fitAddon = addon;

    // Hand the route a live handle. The handle reads the module-scoped `term`
    // (cleared on teardown) so a late frame after unmount is a no-op, never a
    // write to a disposed terminal. `xterm.write` owns UTF-8 decoding.
    onready({
      write: (dataB64) => term?.write(decodeB64Utf8ToBytes(dataB64)),
      reset: (snapshotB64) => {
        if (!term) return;
        term.reset();
        term.write(decodeB64Utf8ToBytes(snapshotB64));
      },
    });

    // Report the initial size so the daemon (which spawns at a default 80x24)
    // adopts this browser's dimensions.
    onresize(terminal.cols, terminal.rows);

    const observer = new ResizeObserver(() => {
      addon.fit();
      onresize(terminal.cols, terminal.rows);
    });
    observer.observe(containerEl);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      terminal.dispose();
      term = undefined;
      fitAddon = undefined;
    };
  });
</script>

<div bind:this={containerEl} data-testid="pty-terminal" class="flex-1 min-h-0 overflow-hidden bg-black p-2"></div>
