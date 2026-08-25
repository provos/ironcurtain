import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import {
  appendBoundedOutput,
  hasClaudeTuiEvidence,
  renderCurrentTerminalScreen,
  resetTerminalEvidenceViewport,
} from '../scripts/smoke-nested-apple-tui.js';

const { Terminal } = xtermHeadless;

function writeTerminal(terminal: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise((resolvePromise) => terminal.write(data, resolvePromise));
}

describe('nested Apple PTY smoke evidence', () => {
  it('accepts the rendered Claude 2.1.240 ASCII-logo layout after a post-activation update', async () => {
    const terminal = new Terminal({ cols: 80, rows: 8, allowProposedApi: true });
    await writeTerminal(terminal, '\x1b[2J\x1b[H      Claude');
    await writeTerminal(
      terminal,
      ' Code v2.1.240\r\n      for agents\r\n\r\n❯ \r\n? for shortcuts                       high · /effort',
    );

    expect(
      hasClaudeTuiEvidence({
        renderedScreen: renderCurrentTerminalScreen(terminal),
        receivedPostActivationOutput: true,
        childAlive: true,
      }),
    ).toBe(true);
  });

  it('rejects pre-activation diagnostics even when unrelated terminal chrome is visible', () => {
    expect(
      hasClaudeTuiEvidence({
        renderedScreen: 'selected agent: Claude Code\nrun /help for details\nstartup complete',
        receivedPostActivationOutput: true,
        childAlive: true,
      }),
    ).toBe(false);
  });

  it('cannot combine a qualifying pre-activation screen with unrelated post-activation output', async () => {
    const terminal = new Terminal({ cols: 80, rows: 8, allowProposedApi: true });
    await writeTerminal(terminal, 'Claude Code v2.1.240\r\nfor agents\r\n❯ \r\nhigh · /effort');
    expect(
      hasClaudeTuiEvidence({
        renderedScreen: renderCurrentTerminalScreen(terminal),
        receivedPostActivationOutput: true,
        childAlive: true,
      }),
    ).toBe(true);

    await resetTerminalEvidenceViewport(terminal);
    await writeTerminal(terminal, 'post-activation heartbeat');

    expect(
      hasClaudeTuiEvidence({
        renderedScreen: renderCurrentTerminalScreen(terminal),
        receivedPostActivationOutput: true,
        childAlive: true,
      }),
    ).toBe(false);
  });

  it.each([
    { receivedPostActivationOutput: false, childAlive: true },
    { receivedPostActivationOutput: true, childAlive: false },
  ])('requires post-activation output and a live child: %j', (state) => {
    expect(
      hasClaudeTuiEvidence({
        renderedScreen: 'Claude Code v2.1.240\nfor agents\n❯ \nhigh · /effort',
        ...state,
      }),
    ).toBe(false);
  });

  it('renders only the current viewport rather than stale startup scrollback', async () => {
    const terminal = new Terminal({ cols: 40, rows: 3, allowProposedApi: true });
    await writeTerminal(terminal, 'selected agent: Claude Code\r\nline 1\r\nline 2\r\nline 3\r\ncurrent');

    expect(renderCurrentTerminalScreen(terminal)).toBe('line 2\nline 3\ncurrent');
  });

  it('bounds retained diagnostic output to a UTF-8-safe tail', () => {
    const output = appendBoundedOutput('x'.repeat(100), 'newest: Claude Code ✓', 96);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(96);
    expect(output).toContain('newest: Claude Code ✓');
  });
});
