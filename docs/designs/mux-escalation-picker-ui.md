# Mux Escalation Picker UI -- Feasibility Analysis

## 1. Current Escalation UX Flow

### How escalations surface today

The mux has two input modes relevant to escalations: **PTY mode** (keystrokes go to the active child process) and **command mode** (keystrokes go to a line editor). The user toggles between them with Ctrl-A.

When an escalation arrives:

1. `MuxEscalationManager.onEscalation` fires, triggers a BEL character (`\x07`) to the terminal
2. The tab bar redraws with a yellow `[!N pending]` badge (right-aligned)
3. The footer in PTY mode shows guidance: `N escalation(s) pending -- /approve, /approve+, or /deny`
4. The user presses **Ctrl-A** to enter command mode

In command mode, the overlay paints over the bottom of the PTY viewport:

```
[escalation panel]  -- 0 to MAX_ESCALATION_PANEL_ROWS (12) rows
[hint bar]          -- 1 row: shows /approve N, /deny N, etc.
[input line]        -- 1-6 rows: the command/trusted-input editor
```

The escalation panel shows each pending escalation in up to 4 rows:
- Header: `[N] Session #M  server/tool`
- Arguments: packed `key: value` pairs
- Reason line
- Whitelist candidate line (if applicable)

An overflow indicator shows `[+N more -- /approve all or /deny all]` when not all fit.

### How the user resolves escalations

The user types a slash command in the input line:
- `/approve 3` -- approve escalation #3
- `/approve+ 3` -- approve with whitelisting
- `/deny 3` -- deny escalation #3
- `/approve all` -- approve all pending
- `/deny all` -- deny all pending

The number comes from the `[N]` display number shown in the escalation panel. The command is parsed in `handleCommand()` in `mux-app.ts`, which calls `escalationManager.resolve(num, decision, whitelist)`.

### Pain points with the current flow

1. **Two-step interaction**: the user must read the display number from the panel, then type it back. This is error-prone when multiple escalations are pending.
2. **No per-item navigation**: there's no way to "focus" a specific escalation to inspect it more closely before deciding.
3. **Limited visibility**: the panel maxes out at 12 rows (3 escalations at 4 rows each). With many pending escalations, the user sees only a few plus an overflow count.
4. **No inline approve/deny**: each resolution requires typing a full command, pressing Enter, reading the flash message. Batch operations (`/approve all`) exist but are all-or-nothing.

## 2. Existing Picker/Overlay Patterns

The codebase already has **three picker overlay implementations** that follow an identical pattern:

| Picker | Mode name | Trigger | State type | Renderer |
|--------|-----------|---------|------------|----------|
| New session | `picker` | `/new` command | `PickerState` | `drawPickerOverlay()` |
| Resume session | `resume-picker` | `/resume` command | `ResumePickerState` | `drawResumePickerOverlay()` |
| Persona | `persona-picker` | `/new` -> "Use a persona" | `PersonaPickerState` | `drawPersonaPickerOverlay()` |

### Common picker pattern

All three pickers follow this architecture:

**Input handler** (`mux-input-handler.ts`):
- Dedicated `InputMode` enum value (e.g. `'resume-picker'`)
- Dedicated state interface with `selectedIndex`, `scrollOffset`, items array
- Dedicated key handler function (arrow keys to navigate, Enter to select, Esc to cancel)
- Enter/exit functions that set the mode and create/null the state
- `isPickerMode()` helper that matches all picker variants

**Renderer** (`mux-renderer.ts`):
- Dedicated `draw*PickerOverlay()` function per picker type
- Bottom-panel pickers use `_layout.pickerY` and `_layout.pickerRows` for positioning (bottom half of viewport)
- The escalation picker is a floating overlay that renders centered over the full PTY viewport (no reserved rows)
- Highlighted item shown with `term.bgCyan.black('> ...')`

**Types** (`types.ts`):
- `isBottomPanelPicker()` matches picker/resume-picker/persona-picker (claim viewport rows)
- `isPickerMode()` matches all pickers including escalation-picker
- `calculateLayout()` only reserves `pickerRows` for bottom-panel pickers

**App** (`mux-app.ts`):
- `handleAction()` dispatches picker actions (`enter-picker-mode`, `picker-cancel`, `picker-spawn`, etc.)
- `MuxRendererDeps` provides getter for each picker state
- `drawActiveOverlay()` dispatches to the correct draw function based on mode

### Input routing

The key routing is clean and centralized in `MuxInputHandler.handleKey()`:

```
if mode === 'pty'            -> handlePtyKey()      -- all keys to PTY except Ctrl-A
if mode === 'picker'         -> handlePickerKey()    -- arrow/enter/esc
if mode === 'resume-picker'  -> handleResumePickerKey()
if mode === 'persona-picker' -> handlePersonaPickerKey()
if mode === 'command'        -> handleCommandKey()   -- line editor
```

While a picker is open, PTY input is **fully blocked** -- keystrokes don't reach the child process. This is acceptable because pickers are brief, user-initiated interactions.

### Rendering model

The mux uses **terminal-kit** for cursor positioning and styled output, plus **xterm.js headless** for PTY buffer management. There are no real "layers" -- the renderer paints regions sequentially from top to bottom: tab bar, PTY viewport, footer, then whichever overlay is active. Overlays paint over the bottom rows of the PTY viewport. The PTY viewport size is constant; overlays just reduce the number of rows the PTY renderer draws.

## 3. Implementation Design: Tab-Per-Escalation Picker

### 3.1 Design Overview

The escalation picker uses a **tab-per-escalation** model: each pending escalation gets a full-detail view. Left/Right arrows (or Tab/Shift-Tab) switch between escalations. The currently viewed escalation is always shown with full detail. Single-key presses (a/d/w) resolve the focused escalation immediately.

The picker **auto-opens** when a new escalation arrives and **auto-closes** when all escalations are resolved. The user can dismiss it with Esc to return to PTY/command mode, and re-open it with Ctrl-E.

### 3.2 Type Definitions

#### InputMode addition (`src/mux/types.ts`)

```typescript
export type InputMode = 'pty' | 'command' | 'picker' | 'resume-picker' | 'persona-picker' | 'escalation-picker';

export function isPickerMode(mode: InputMode): boolean {
  return mode === 'picker' || mode === 'resume-picker' || mode === 'persona-picker' || mode === 'escalation-picker';
}
```

#### EscalationPickerState (`src/mux/mux-input-handler.ts`)

```typescript
export interface EscalationPickerState {
  /**
   * The display number of the currently focused escalation tab.
   * This is NOT an array index -- it's the monotonic displayNumber from
   * PendingEscalation, which survives additions and removals.
   */
  focusedDisplayNumber: number;

  /**
   * The mode the user was in before the picker opened.
   * Used to restore when the picker is dismissed with Esc.
   */
  previousMode: 'pty' | 'command';

  /**
   * Whether the picker was dismissed by the user (Esc).
   * When true, auto-open is suppressed until a NEW escalation arrives
   * (one whose displayNumber is higher than any seen when dismissed).
   * Reset to false when a new escalation triggers auto-open.
   */
  dismissed: boolean;

  /**
   * The highest displayNumber that was pending when the user last
   * dismissed the picker. Auto-open only fires for escalations with
   * displayNumber > this value.
   */
  dismissedAtNumber: number;
}
```

The `dismissed` and `dismissedAtNumber` fields live on the handler (not on the state object that gets nulled), since they must survive across dismiss/re-open cycles. They are separate tracking variables in the handler closure:

```typescript
// Inside createMuxInputHandler closure:
let _escalationPickerState: EscalationPickerState | null = null;
let _escalationDismissed = false;
let _escalationDismissedAtNumber = 0;
```

#### New MuxAction variants (`src/mux/types.ts`)

```typescript
export type MuxAction =
  // ... existing variants ...
  | { readonly kind: 'escalation-resolve'; readonly displayNumber: number; readonly decision: 'approved' | 'denied'; readonly whitelist: boolean }
  | { readonly kind: 'escalation-resolve-all'; readonly decision: 'approved' | 'denied'; readonly whitelist: boolean }
  | { readonly kind: 'escalation-dismiss' }
  | { readonly kind: 'escalation-open' }
  // ... rest of existing variants ...
```

### 3.3 Input Handler Behavior

#### Enter/exit functions

```typescript
function enterEscalationPickerMode(
  focusedDisplayNumber: number,
  previousMode: 'pty' | 'command',
): void {
  _mode = 'escalation-picker';
  _escalationPickerState = {
    focusedDisplayNumber,
    previousMode,
  };
  _escalationDismissed = false;
}

function exitEscalationPickerMode(): void {
  const prev = _escalationPickerState?.previousMode ?? 'pty';
  _mode = prev;
  _escalationPickerState = null;
}

function dismissEscalationPicker(highestPendingNumber: number): void {
  _escalationDismissed = true;
  _escalationDismissedAtNumber = highestPendingNumber;
  exitEscalationPickerMode();
}
```

Both `enterEscalationPickerMode` and `dismissEscalationPicker` are public methods on the `MuxInputHandler` interface so `mux-app.ts` can call them.

#### Key handler: `handleEscalationPickerKey(key)`

| Key | Action |
|-----|--------|
| `RIGHT`, `TAB` | Move to next escalation tab (wrap around) |
| `LEFT`, `SHIFT_TAB` | Move to previous escalation tab (wrap around) |
| `a` | Resolve focused escalation as approved -> `{ kind: 'escalation-resolve', displayNumber, decision: 'approved', whitelist: false }` |
| `d` | Resolve focused escalation as denied -> `{ kind: 'escalation-resolve', displayNumber, decision: 'denied', whitelist: false }` |
| `w` | Resolve focused escalation as approved with whitelist -> `{ kind: 'escalation-resolve', displayNumber, decision: 'approved', whitelist: true }` |
| `A` (shift-a) | Resolve ALL as approved -> `{ kind: 'escalation-resolve-all', decision: 'approved', whitelist: false }` |
| `D` (shift-d) | Resolve ALL as denied -> `{ kind: 'escalation-resolve-all', decision: 'denied', whitelist: false }` |
| `ESCAPE` | Dismiss picker -> `{ kind: 'escalation-dismiss' }` |
| `CTRL_A` | Dismiss picker, enter command mode (same as Esc but always goes to command) -> `{ kind: 'escalation-dismiss' }` |
| any other key | `{ kind: 'none' }` |

Implementation of tab navigation:

```typescript
function handleEscalationPickerKey(key: string): MuxAction {
  const eps = _escalationPickerState;
  if (!eps) return { kind: 'none' };

  if (key === ESCAPE || key === CTRL_C) {
    return { kind: 'escalation-dismiss' };
  }

  if (key === CTRL_A) {
    return { kind: 'escalation-dismiss' };
  }

  // Tab navigation: LEFT/SHIFT_TAB = prev, RIGHT/TAB = next
  if (key === RIGHT || key === TAB) {
    return { kind: 'escalation-navigate', direction: 'next' };
  }
  if (key === LEFT || key === 'SHIFT_TAB') {
    return { kind: 'escalation-navigate', direction: 'prev' };
  }

  // Single-key resolve actions
  if (key === 'a') {
    return { kind: 'escalation-resolve', displayNumber: eps.focusedDisplayNumber, decision: 'approved', whitelist: false };
  }
  if (key === 'd') {
    return { kind: 'escalation-resolve', displayNumber: eps.focusedDisplayNumber, decision: 'denied', whitelist: false };
  }
  if (key === 'w') {
    return { kind: 'escalation-resolve', displayNumber: eps.focusedDisplayNumber, decision: 'approved', whitelist: true };
  }

  // Batch resolve (shift keys)
  if (key === 'A') {
    return { kind: 'escalation-resolve-all', decision: 'approved', whitelist: false };
  }
  if (key === 'D') {
    return { kind: 'escalation-resolve-all', decision: 'denied', whitelist: false };
  }

  return { kind: 'none' };
}
```

Note: unlike other pickers where the input handler mutates state in-place and returns `{ kind: 'redraw-picker' }`, the escalation picker emits `{ kind: 'escalation-navigate', direction }` because the input handler does not have access to the live pending escalations list. Navigation is handled by `mux-app.ts` which reads the sorted display numbers from `escalationManager` and updates `eps.focusedDisplayNumber`.

This requires one additional MuxAction variant:

```typescript
| { readonly kind: 'escalation-navigate'; readonly direction: 'next' | 'prev' }
```

The reason navigation is an action (unlike other pickers): the input handler does **not** hold a copy of the pending escalations list. Other pickers snapshot their items on enter. The escalation picker references live state from `escalationManager`, so `mux-app.ts` handles the navigation by reading the live sorted display numbers and updating `focusedDisplayNumber`.

#### Ctrl-E interception in PTY and command modes

In `handlePtyKey()`:

```typescript
function handlePtyKey(key: string): MuxAction {
  if (key === CTRL_A) {
    _mode = 'command';
    return { kind: 'enter-command-mode' };
  }
  if (key === 'CTRL_E') {
    return { kind: 'escalation-open' };
  }
  return { kind: 'write-pty', data: KEY_TO_SEQUENCE[key] ?? key };
}
```

In `handleCommandKey()`:

```typescript
// Add after the CTRL_A check:
if (key === 'CTRL_E') {
  return { kind: 'escalation-open' };
}
```

#### handleKey routing addition

```typescript
handleKey(key: string): MuxAction {
  if (_mode === 'pty') return handlePtyKey(key);
  if (_mode === 'picker') return handlePickerKey(key);
  if (_mode === 'resume-picker') return handleResumePickerKey(key);
  if (_mode === 'persona-picker') return handlePersonaPickerKey(key);
  if (_mode === 'escalation-picker') return handleEscalationPickerKey(key);
  return handleCommandKey(key);
}
```

### 3.4 Tab Index to Display Number Mapping

The picker does **not** use array indices. It stores `focusedDisplayNumber` directly -- the monotonically increasing number from `PendingEscalation.displayNumber`. This is critical because:

1. Escalations can expire or be resolved while the picker is open, removing entries from the middle.
2. New escalations can arrive, adding entries at the end.
3. Display numbers are what the user sees in the tab header, so the mapping is direct and unambiguous.

Navigation computes the sorted display number list on every key press:

```typescript
// In mux-app.ts handleAction for 'escalation-navigate':
function navigateEscalationTab(direction: 'next' | 'prev'): void {
  const eps = inputHandler.escalationPickerState;
  if (!eps) return;

  const sortedNums = [...escalationManager.state.pendingEscalations.keys()].sort((a, b) => a - b);
  if (sortedNums.length === 0) return;

  const currentIdx = sortedNums.indexOf(eps.focusedDisplayNumber);
  let newIdx: number;

  if (currentIdx === -1) {
    // Focused escalation was resolved/expired -- snap to nearest
    newIdx = 0;
  } else if (direction === 'next') {
    newIdx = (currentIdx + 1) % sortedNums.length;
  } else {
    newIdx = (currentIdx - 1 + sortedNums.length) % sortedNums.length;
  }

  eps.focusedDisplayNumber = sortedNums[newIdx];
}
```

### 3.5 Auto-Open / Auto-Close Logic

#### Where it hooks in

The escalation manager's `onChange` callback in `mux-app.ts` already fires on every escalation state change. The auto-open/auto-close logic lives entirely in this callback:

```typescript
// In mux-app.ts, inside start():
escalationManager.onChange(() => {
  const pendingCount = escalationManager.pendingCount;
  const mode = inputHandler.mode;

  // --- Auto-close: picker is open but nothing left ---
  if (mode === 'escalation-picker' && pendingCount === 0) {
    inputHandler.exitEscalationPickerMode();
    renderer.fullRedraw();
    return;
  }

  // --- Auto-open: new escalation arrived, picker not already open ---
  if (pendingCount > 0 && mode !== 'escalation-picker') {
    const highestPending = Math.max(...escalationManager.state.pendingEscalations.keys());

    // Only auto-open if the user hasn't dismissed, OR if a genuinely new
    // escalation arrived (higher display number than when they dismissed).
    const shouldAutoOpen =
      !inputHandler.escalationDismissed ||
      highestPending > inputHandler.escalationDismissedAtNumber;

    if (shouldAutoOpen) {
      // Determine the previous mode for restoring on dismiss
      const previousMode: 'pty' | 'command' =
        mode === 'pty' ? 'pty' :
        mode === 'command' ? 'command' :
        'pty'; // if in another picker, treat as pty

      // If user is in another picker, cancel it first
      if (isPickerMode(mode)) {
        // Cancel whatever picker is open (don't lose data -- these are
        // all read-only selection UIs, not forms)
        inputHandler.exitPickerMode();
      }

      // Focus the newest escalation
      inputHandler.enterEscalationPickerMode(highestPending, previousMode);
      renderer.fullRedraw();
      process.stderr.write('\x07'); // BEL
      return;
    }
  }

  // --- Live update while picker is open: re-validate focused tab ---
  if (mode === 'escalation-picker') {
    const eps = inputHandler.escalationPickerState;
    if (eps && !escalationManager.state.pendingEscalations.has(eps.focusedDisplayNumber)) {
      // Focused escalation was resolved or expired -- snap to nearest
      const sortedNums = [...escalationManager.state.pendingEscalations.keys()].sort((a, b) => a - b);
      if (sortedNums.length > 0) {
        eps.focusedDisplayNumber = sortedNums[0];
      }
      // If sortedNums is empty, auto-close above will handle it on next tick
    }
  }

  renderer.redrawTabBar();
  renderer.redrawCommandArea();
});
```

#### Edge cases

| Scenario | Behavior |
|----------|----------|
| User in PTY, first escalation arrives | Auto-open picker. `previousMode = 'pty'`. |
| User in command mode typing, escalation arrives | Auto-open picker. `previousMode = 'command'`. Input buffer is preserved (not cleared). |
| User in another picker (e.g. /new), escalation arrives | Cancel the other picker, auto-open escalation picker. `previousMode = 'pty'`. |
| User dismisses with Esc, no new escalations arrive | Picker stays closed. Badge in tab bar still visible. |
| User dismisses with Esc, then a NEW escalation arrives | Auto-open fires (new displayNumber > dismissedAtNumber). |
| User dismisses with Esc, then presses Ctrl-E | Manual open always works, regardless of dismiss state. |
| User resolves focused escalation (a/d/w), more remain | Picker stays open. Focus moves to next escalation (or previous if last was focused). |
| User resolves focused escalation, none remain | Auto-close fires. Returns to `previousMode`. |
| Escalation expires while picker is open and focused on it | Focus snaps to nearest remaining escalation. |
| Escalation expires while picker is open but focused on different one | No visible change except tab count updates. |
| All escalations expire while picker is open | Auto-close fires. Returns to `previousMode`. |

### 3.6 Action Handling in mux-app.ts

```typescript
// Add to handleAction() switch:

case 'escalation-open': {
  if (escalationManager.pendingCount === 0) {
    showMessage('No pending escalations');
    break;
  }
  const sortedNums = [...escalationManager.state.pendingEscalations.keys()].sort((a, b) => a - b);
  const previousMode: 'pty' | 'command' =
    inputHandler.mode === 'command' ? 'command' : 'pty';
  inputHandler.enterEscalationPickerMode(sortedNums[0], previousMode);
  renderer.fullRedraw();
  break;
}

case 'escalation-dismiss': {
  const highestPending = escalationManager.pendingCount > 0
    ? Math.max(...escalationManager.state.pendingEscalations.keys())
    : 0;
  inputHandler.dismissEscalationPicker(highestPending);
  renderer.fullRedraw();
  break;
}

case 'escalation-navigate': {
  navigateEscalationTab(action.direction);
  renderer.redrawCommandArea();
  break;
}

case 'escalation-resolve': {
  const message = escalationManager.resolve(action.displayNumber, action.decision, action.whitelist);
  showMessage(message);
  // After resolve, if picker still open, the onChange callback handles
  // focus adjustment and auto-close.
  renderer.redrawTabBar();
  renderer.redrawCommandArea();
  break;
}

case 'escalation-resolve-all': {
  const message = escalationManager.resolveAll(action.decision, action.whitelist);
  showMessage(message);
  // onChange callback will auto-close the picker since pendingCount -> 0
  renderer.redrawTabBar();
  renderer.redrawCommandArea();
  break;
}
```

### 3.7 Renderer Layout

#### Overlay sizing

The escalation picker renders as a **floating overlay** centered over the full PTY viewport. Unlike bottom-panel pickers (which claim `_layout.pickerRows`), the escalation picker does not reserve any viewport rows — `isBottomPanelPicker()` excludes `'escalation-picker'`, so `calculateLayout()` sets `pickerRows = 0`. The overlay dimensions are computed dynamically in `drawEscalationPickerOverlay()` based on content and terminal size.

#### Visual layout: single escalation

```
  Escalation [3]  (1 of 1)
  ──────────────────────────────────────────────────────────
  Session #1  filesystem/write_file                    12s ago
  ──────────────────────────────────────────────────────────
  Arguments:
    path: /home/user/project/src/main.ts
    content: (248 chars) "import { foo } from './bar';\n..."
  Reason:
    write outside sandbox
  Whitelist:
    /approve+ will whitelist: write_file to /home/user/project/src/
  ──────────────────────────────────────────────────────────
   a  approve    d  deny    w  approve+    Esc  dismiss
```

#### Visual layout: multiple escalations (2+)

```
  [3] filesystem/write_file    >[4] filesystem/delete_file    [5] git/push
  ──────────────────────────────────────────────────────────
  Session #1  filesystem/delete_file                     8s ago
  ──────────────────────────────────────────────────────────
  Arguments:
    path: /home/user/project/old-module.ts
  Reason:
    delete outside sandbox
  ──────────────────────────────────────────────────────────
   a  approve    d  deny    w  approve+    A  approve all    D  deny all    Esc  dismiss
```

#### Row allocation within the overlay

```
Row 0:        Tab bar (display numbers, focused tab highlighted)
Row 1:        Separator
Row 2:        Tool header (Session #N  server/tool  time-ago)
Row 3:        Separator
Rows 4..N-2:  Detail area (arguments, reason, whitelist -- scrollable if overflow)
Row N-1:      Separator
Row N:        Hint bar (key bindings)
```

Fixed rows: tab bar (1) + 2 separators (2) + tool header (1) + hint bar (1) = 5 rows overhead. Remaining rows go to the detail area. With a typical 12-row picker overlay, that gives 7 rows for detail content, which is generous for most tool calls.

#### drawEscalationPickerOverlay() implementation sketch

```typescript
function drawEscalationPickerOverlay(): void {
  const eps = deps.getEscalationPickerState();
  if (!eps) return;

  // Floating overlay: compute dimensions dynamically (no reserved layout rows).
  // See actual implementation for full sizing/centering logic.

  const pending = deps.getEscalationState().pendingEscalations;
  const sortedEscalations = [...pending.values()].sort((a, b) => a.displayNumber - b.displayNumber);

  if (sortedEscalations.length === 0) return; // auto-close should handle this

  const focused = pending.get(eps.focusedDisplayNumber);
  if (!focused) return; // stale focus, onChange will fix

  let currentY = startY;

  // Row 0: Tab bar -- each escalation gets a tab label
  clearLine(currentY);
  moveTo(2, currentY);
  for (const esc of sortedEscalations) {
    const isFocused = esc.displayNumber === eps.focusedDisplayNumber;
    const label = ` [${esc.displayNumber}] ${esc.request.serverName}/${esc.request.toolName} `;
    if (isFocused) {
      term.bgCyan.black(label);
      term.styleReset();
    } else {
      term.dim(label);
    }
    term(' ');
  }
  term.eraseLineAfter();
  currentY++;

  // Separator
  clearLine(currentY);
  moveTo(2, currentY);
  term.dim('\u2500'.repeat(Math.max(0, _cols - 4)));
  term.styleReset();
  currentY++;

  // Tool header
  clearLine(currentY);
  moveTo(2, currentY);
  const timeAgo = formatTimeSince(focused.receivedAt);
  term(`Session #${focused.sessionDisplayNumber}  `);
  term.cyan(`${focused.request.serverName}/${focused.request.toolName}`);
  term.dim(`  ${timeAgo}`);
  term.eraseLineAfter();
  currentY++;

  // Separator
  clearLine(currentY);
  moveTo(2, currentY);
  term.dim('\u2500'.repeat(Math.max(0, _cols - 4)));
  term.styleReset();
  currentY++;

  // Detail area: arguments, reason, whitelist
  const detailRows = totalRows - 5; // 5 = tab bar + 2 separators + header + hint bar
  let detailLinesUsed = 0;

  // Arguments
  const argLines = formatArgLines(focused.request.arguments, _cols - 8);
  if (argLines.length > 0) {
    clearLine(currentY);
    moveTo(4, currentY);
    term.dim('Arguments:');
    currentY++;
    detailLinesUsed++;

    for (const line of argLines) {
      if (detailLinesUsed >= detailRows) break;
      clearLine(currentY);
      moveTo(6, currentY);
      term(truncate(line, _cols - 8));
      term.eraseLineAfter();
      currentY++;
      detailLinesUsed++;
    }
  }

  // Reason
  if (detailLinesUsed < detailRows) {
    clearLine(currentY);
    moveTo(4, currentY);
    term.dim('Reason: ');
    term(truncate(focused.request.reason, _cols - 14));
    term.eraseLineAfter();
    currentY++;
    detailLinesUsed++;
  }

  // Whitelist candidates
  if (
    detailLinesUsed < detailRows &&
    focused.request.whitelistCandidates &&
    focused.request.whitelistCandidates.length > 0
  ) {
    const candidate = focused.request.whitelistCandidates[0];
    clearLine(currentY);
    moveTo(4, currentY);
    term.dim('/approve+ ');
    term.cyan(truncate(candidate.description, _cols - 16));
    if (candidate.warning) {
      term.yellow(` (${candidate.warning})`);
    }
    term.eraseLineAfter();
    currentY++;
    detailLinesUsed++;
  }

  // Fill remaining detail rows with blank
  while (detailLinesUsed < detailRows) {
    clearLine(currentY);
    currentY++;
    detailLinesUsed++;
  }

  // Hint bar
  clearLine(currentY);
  moveTo(2, currentY);
  term.bgWhite.black(' a ');
  term.styleReset();
  term.dim(' approve  ');
  term.bgWhite.black(' d ');
  term.styleReset();
  term.dim(' deny  ');
  term.bgWhite.black(' w ');
  term.styleReset();
  term.dim(' approve+  ');
  if (sortedEscalations.length > 1) {
    term.bgWhite.black(' A ');
    term.styleReset();
    term.dim(' all  ');
    term.bgWhite.black(' D ');
    term.styleReset();
    term.dim(' deny all  ');
    term.bgWhite.black(' \u2190\u2192 ');
    term.styleReset();
    term.dim(' switch  ');
  }
  term.bgWhite.black(' Esc ');
  term.styleReset();
  term.dim(' dismiss');
  term.eraseLineAfter();
}
```

#### Wire into drawActiveOverlay

```typescript
function drawActiveOverlay(): void {
  const mode = deps.getMode();
  if (mode === 'command') drawCommandOverlay();
  else if (mode === 'picker') drawPickerOverlay();
  else if (mode === 'resume-picker') drawResumePickerOverlay();
  else if (mode === 'persona-picker') drawPersonaPickerOverlay();
  else if (mode === 'escalation-picker') drawEscalationPickerOverlay();
}
```

#### Helper: formatTimeSince

```typescript
function formatTimeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
```

### 3.8 Live Update Behavior

Unlike other pickers that snapshot their data on open, the escalation picker reads live state from `escalationManager.state.pendingEscalations` on every render. This is the fundamental difference from other pickers and it drives several design choices:

| Event | Effect on picker |
|-------|-----------------|
| New escalation arrives while picker is open | New tab appears in tab bar. Focus stays on current tab. Tab bar redraws. |
| Focused escalation is resolved by user (a/d/w) | Tab disappears. Focus moves to next tab (or previous if it was last). If none remain, auto-close. |
| Focused escalation expires (timeout) | Same as resolved: focus snaps to nearest remaining tab. |
| Non-focused escalation expires | Tab disappears from tab bar. No focus change. |
| All escalations resolved/expired | Auto-close fires. Mode returns to `previousMode`. |

The renderer always reads the live `pendingEscalations` map; it never caches. The `onChange` callback in `mux-app.ts` handles focus correction and auto-close before triggering a redraw.

### 3.9 MuxRendererDeps Addition

```typescript
export interface MuxRendererDeps {
  // ... existing deps ...
  getEscalationPickerState: () => EscalationPickerState | null;
}
```

Wired in `mux-app.ts`:

```typescript
getEscalationPickerState: () => inputHandler.escalationPickerState,
```

### 3.10 MuxInputHandler Interface Additions

```typescript
export interface MuxInputHandler {
  // ... existing members ...

  /** Current escalation picker state (null when not in escalation picker mode). */
  readonly escalationPickerState: EscalationPickerState | null;

  /** Whether the escalation picker was dismissed by the user. */
  readonly escalationDismissed: boolean;

  /** The highest display number when the picker was last dismissed. */
  readonly escalationDismissedAtNumber: number;

  /** Enter escalation picker mode. */
  enterEscalationPickerMode(focusedDisplayNumber: number, previousMode: 'pty' | 'command'): void;

  /** Exit escalation picker mode (return to previous mode). */
  exitEscalationPickerMode(): void;

  /** Dismiss (Esc) the escalation picker, suppressing auto-open until new escalation. */
  dismissEscalationPicker(highestPendingNumber: number): void;
}
```

### 3.11 Interaction with Command-Mode Escalation Panel

The existing command-mode escalation panel (in `drawCommandOverlay()`) is **kept as-is**. It continues to show escalation details when the user is in command mode and the escalation picker is not open.

Rationale: the command-mode panel serves a different purpose -- it is passive context while the user types commands. The `/approve` and `/deny` commands continue to work. Power users who prefer typing over the picker can still use the old flow. The escalation picker is an accelerator, not a replacement.

The only interaction concern is that auto-open will pull the user out of command mode into the picker when a new escalation arrives. This is intentional -- the escalation requires attention. If the user dismisses with Esc, they return to command mode and can use `/approve` as before.

### 3.12 Footer Hint Update

When in PTY mode with pending escalations, the footer currently shows:

```
N escalation(s) pending -- /approve, /approve+, or /deny
```

This changes to show the Ctrl-E binding:

```
N escalation(s) pending -- Ctrl-E to review
```

The longer `/approve` command hints are no longer needed in the footer since the picker makes them discoverable. The slash commands still work in command mode; they just are not advertised in PTY mode anymore.

### 3.13 Files to Modify

| File | Changes |
|------|---------|
| `src/mux/types.ts` | Add `'escalation-picker'` to `InputMode`. Update `isPickerMode()`. Add 5 new `MuxAction` variants (`escalation-resolve`, `escalation-resolve-all`, `escalation-dismiss`, `escalation-open`, `escalation-navigate`). |
| `src/mux/mux-input-handler.ts` | Add `EscalationPickerState` interface. Add `_escalationPickerState`, `_escalationDismissed`, `_escalationDismissedAtNumber` closure vars. Add `handleEscalationPickerKey()`. Add `enterEscalationPickerMode()`, `exitEscalationPickerMode()`, `dismissEscalationPicker()`. Add Ctrl-E handling to `handlePtyKey()` and `handleCommandKey()`. Wire into `handleKey()` dispatch. Expose new state/methods on returned interface. |
| `src/mux/mux-renderer.ts` | Add `drawEscalationPickerOverlay()`. Add `formatTimeSince()` helper. Wire into `drawActiveOverlay()`. Add `getEscalationPickerState` to `MuxRendererDeps`. Update PTY-mode footer hint text for Ctrl-E. |
| `src/mux/mux-app.ts` | Handle new action kinds in `handleAction()`. Add `navigateEscalationTab()` helper. Rewrite `escalationManager.onChange()` callback for auto-open/auto-close logic. Pass `getEscalationPickerState` to renderer deps. |

No new files needed. The pattern is established well enough that all changes fit into existing modules.

### 3.14 Testing Strategy

The input handler is a pure state machine (key in, action out). Tests for the escalation picker follow the same pattern as existing picker tests:

1. **Key mapping tests**: verify each key produces the correct `MuxAction` variant.
2. **Enter/exit tests**: verify mode transitions and `previousMode` preservation.
3. **Dismiss semantics**: verify that `dismissEscalationPicker()` sets the dismissed flag and threshold, and that `enterEscalationPickerMode()` clears the dismissed flag.
4. **Navigation**: not directly testable in the input handler (it emits `escalation-navigate` actions). Test the `navigateEscalationTab()` helper in `mux-app.ts` with mock escalation manager state -- verify wraparound, focus snapping when current escalation is gone, single-item no-op.

The auto-open/auto-close logic in the `onChange` callback is integration-level: test it by constructing a `MuxEscalationManager` mock, simulating escalation arrivals, and verifying that the input handler's mode transitions correctly.

The renderer is not unit-tested (consistent with existing pickers).

### 3.15 Estimated Effort

This is a **medium feature** (2-3 days). The tab-per-escalation model is simpler than a list+detail split view (no scroll state within the list, no list/detail phase toggle), but the auto-open/auto-close logic and live update handling add complexity beyond a static picker.
