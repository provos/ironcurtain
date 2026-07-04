/**
 * Unit tests for the PTY bridge (src/pty/pty-bridge.ts):
 *  - `buildSpawnArgs`: pure child-argv construction (F6), testable without spawning.
 *  - `createPtyBridge` output wiring: the `onData` stream sink + `serialize()`
 *    reconnect snapshot (web-ui additions), with node-pty and the session
 *    registry mocked so no real child is spawned and discovery resolves at once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSpawnArgs, createPtyBridge, type PtyBridgeOptions } from '../src/pty/pty-bridge.js';

/** Shared, mutable fake-child state reachable from the hoisted node-pty mock. */
const ptyMock = vi.hoisted(() => {
  const state: {
    dataCb?: (d: string) => void;
    exitCb?: (e: { exitCode: number }) => void;
  } = {};
  return { state };
});

vi.mock('node-pty', () => {
  const spawn = () => ({
    pid: 424242,
    onData: (cb: (d: string) => void) => {
      ptyMock.state.dataCb = cb;
    },
    onExit: (cb: (e: { exitCode: number }) => void) => {
      ptyMock.state.exitCb = cb;
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => ptyMock.state.exitCb?.({ exitCode: 0 })),
  });
  return { default: { spawn }, spawn };
});

// Resolve discovery immediately with a matching registration so the bridge's
// background poll returns on its first iteration -- no 200ms timer outlives a test.
vi.mock('../src/escalation/session-registry.js', () => ({
  readActiveRegistrations: () => [{ pid: 424242, sessionId: 'sess-test', escalationDir: '/tmp/esc-test' }],
}));

/** Minimal always-required options; per-test flags are layered on top. */
function baseOptions(overrides: Partial<PtyBridgeOptions> = {}): PtyBridgeOptions {
  return {
    cols: 80,
    rows: 24,
    ironcurtainBin: 'ironcurtain',
    agent: 'claude-code',
    ...overrides,
  };
}

describe('buildSpawnArgs', () => {
  it('always emits the start --pty --agent base', () => {
    expect(buildSpawnArgs(baseOptions())).toEqual(['start', '--pty', '--agent', 'claude-code']);
  });

  it('prepends prefixArgs (tsx loader / script path) before the subcommand', () => {
    const args = buildSpawnArgs(baseOptions({ prefixArgs: ['--import', 'tsx', '/path/cli.ts'] }));
    expect(args.slice(0, 5)).toEqual(['--import', 'tsx', '/path/cli.ts', 'start', '--pty']);
  });

  it('appends --provider-profile <name> when providerProfileName is set', () => {
    const args = buildSpawnArgs(baseOptions({ providerProfileName: 'kimi' }));
    expect(args).toContain('--provider-profile');
    const flagIdx = args.indexOf('--provider-profile');
    expect(args[flagIdx + 1]).toBe('kimi');
  });

  it('omits --provider-profile when providerProfileName is unset', () => {
    expect(buildSpawnArgs(baseOptions())).not.toContain('--provider-profile');
  });

  it('omits --provider-profile when providerProfileName is empty string', () => {
    expect(buildSpawnArgs(baseOptions({ providerProfileName: '' }))).not.toContain('--provider-profile');
  });

  // --- Pin existing flag behavior so the extraction didn't regress it. ---

  it('appends --workspace <path> when set, omits when unset', () => {
    expect(buildSpawnArgs(baseOptions({ workspacePath: '/w/s' }))).toContain('--workspace');
    const args = buildSpawnArgs(baseOptions({ workspacePath: '/w/s' }));
    expect(args[args.indexOf('--workspace') + 1]).toBe('/w/s');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--workspace');
  });

  it('appends --persona <name> when set, omits when unset', () => {
    const args = buildSpawnArgs(baseOptions({ persona: 'exec-assistant' }));
    expect(args[args.indexOf('--persona') + 1]).toBe('exec-assistant');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--persona');
  });

  it('appends --resume <id> when set, omits when unset', () => {
    const args = buildSpawnArgs(baseOptions({ resumeSessionId: 'session-xyz' }));
    expect(args[args.indexOf('--resume') + 1]).toBe('session-xyz');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--resume');
  });

  it('appends --model <id> when set, omits when unset', () => {
    const args = buildSpawnArgs(baseOptions({ model: 'claude-opus-4' }));
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--model');
  });

  it('appends --capture-traces (a boolean flag) only when true', () => {
    expect(buildSpawnArgs(baseOptions({ captureTraces: true }))).toContain('--capture-traces');
    expect(buildSpawnArgs(baseOptions({ captureTraces: false }))).not.toContain('--capture-traces');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--capture-traces');
  });

  it('emits all selection flags together in the documented order', () => {
    const args = buildSpawnArgs(
      baseOptions({
        prefixArgs: ['/cli.js'],
        resumeSessionId: 'sid',
        workspacePath: '/ws',
        persona: 'p',
        providerProfileName: 'glm-5.2',
        model: 'm',
        captureTraces: true,
      }),
    );
    expect(args).toEqual([
      '/cli.js',
      'start',
      '--pty',
      '--agent',
      'claude-code',
      '--resume',
      'sid',
      '--workspace',
      '/ws',
      '--persona',
      'p',
      '--provider-profile',
      'glm-5.2',
      '--model',
      'm',
      '--capture-traces',
    ]);
  });
});

describe('createPtyBridge — output wiring (onData / serialize)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    ptyMock.state.dataCb = undefined;
    ptyMock.state.exitCb = undefined;
  });

  it('onData fires with the chunk AFTER the headless buffer reflects it', async () => {
    const bridge = await createPtyBridge(baseOptions());
    const observed: Array<{ chunk: string; inSnapshot: boolean }> = [];
    // A serialize() taken inside the onData handler must already contain the chunk
    // -- this is the reconnect ordering invariant (onData fires post buffer-write).
    bridge.onData((chunk) => {
      observed.push({ chunk, inSnapshot: bridge.serialize().includes('MARKER') });
    });

    ptyMock.state.dataCb?.('MARKER-text');
    await tick();

    expect(observed).toHaveLength(1);
    expect(observed[0].chunk).toBe('MARKER-text');
    expect(observed[0].inSnapshot).toBe(true);
    bridge.kill();
  });

  it('fires onOutput (grid sink) before onData (stream sink)', async () => {
    const bridge = await createPtyBridge(baseOptions());
    const order: string[] = [];
    bridge.onOutput(() => order.push('output'));
    bridge.onData(() => order.push('data'));

    ptyMock.state.dataCb?.('x');
    await tick();

    expect(order).toEqual(['output', 'data']);
    bridge.kill();
  });

  it('onData unsubscribe stops further callbacks', async () => {
    const bridge = await createPtyBridge(baseOptions());
    const seen: string[] = [];
    const unsub = bridge.onData((c) => seen.push(c));

    ptyMock.state.dataCb?.('a');
    await tick();
    unsub();
    ptyMock.state.dataCb?.('b');
    await tick();

    expect(seen).toEqual(['a']);
    bridge.kill();
  });

  it('serialize() reflects written screen content', async () => {
    const bridge = await createPtyBridge(baseOptions());
    ptyMock.state.dataCb?.('hello serialize');
    await tick();
    expect(bridge.serialize()).toContain('hello serialize');
    bridge.kill();
  });

  it('serialize({ scrollback }) caps the tail without throwing', async () => {
    const bridge = await createPtyBridge(baseOptions());
    ptyMock.state.dataCb?.('line one\r\nline two');
    await tick();
    const snap = bridge.serialize({ scrollback: 0 });
    expect(typeof snap).toBe('string');
    bridge.kill();
  });
});
